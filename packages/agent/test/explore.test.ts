/** Deep search (explore.ts + its loop wiring), 2026-11-15. */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentEvent } from "@pickle/protocol";
import {
  DEEP_MAX_TOKENS,
  EXHAUSTIVE_SEARCH_DEFAULTS,
  EXPLORE_RULE,
  ExploreTracker,
  CARD_DONE_REPLY,
  CARD_MAX_ROWS,
  CARD_STATUS,
  CARD_COUNT_TOKEN,
  CARD_AGENT_BYTES,
  CARD_PAGE_MS,
  CARD_PAGES_GUARD,
  CARD_HEIGHT_BUDGET,
  CARD_URL_MAX,
  CARD_READ_MS,
  CARD_READ_BY_MS,
  LIST_CHECK,
  PLACES_MAX,
  listPrice,
  nameFee,
  nameWalk,
  cardRowOf,
  cardRows,
  cardTitle,
  drawRowsCard,
  drawRowsCards,
  rowsCardTitle,
  cleanCard,
  priceValue,
  renderRowsCard,
  isPlaceholderPhone,
  scrubPlaceholderPhones,
  LlmClient,
  ToolMarkupFilter,
  VOICE_SEARCH_PREFACE,
  cardToolOf,
  createRunTurn,
  domainOf,
  exploreHints,
  allAgain,
  exploreIntent,
  exploreOpen,
  askedStem,
  askedSidos,
  askedGus,
  exploreKind,
  exploreStatus,
  siteKey,
  systemTools,
  type ToolContext,
  type ToolDef,
  type TurnInput,
} from "../src/index.ts";
import { fakeCtx, startMockLlm } from "./mock-llm.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;
/** a rows card's text kept on one line; the dot that ends an item (it rides with the item, a line breaks after it) */
const nw = (t: string) => `<span class="n">${t}</span>`;
const DOT = "\u00a0·";
/** summary or meta items each kept whole, each but the last with its dot */
const items = (...ts: string[]) => ts.map((t, i) => nw(i < ts.length - 1 ? t + DOT : t)).join(" ");
/** the real html tool (its saveAgentCard: 300 KB, the tool's own refusals) */
const realArt = () => systemTools().find((t) => t.name === "sys_create_artifact")!;
/**
 * A tool context whose store keeps what was saved and with which option. `failFirst`: the first save throws;
 * `toolSize`: refuses html over 150 KB whatever the option.
 */
function cardCtx(o: { failFirst?: boolean; toolSize?: boolean } = {}) {
  const ctx = fakeCtx();
  const saved: { title: string; content: string; opts?: { agentCard?: boolean } }[] = [];
  let n = 0;
  (ctx as { store: unknown }).store = {
    ...ctx.store,
    async createArtifact(a: { title: string; content: string }, opts?: { agentCard?: boolean }) {
      if (o.failFirst && n++ === 0) throw new Error("db busy");
      if (o.toolSize && bytes(a.content) > 150 * 1024) throw new Error("화면이 너무 커요 (150KB 이하)");
      saved.push({ title: a.title, content: a.content, ...(opts ? { opts } : {}) });
      return { id: `art_${saved.length}` };
    },
  };
  cardsOf.set(ctx, saved);
  return { ctx, saved };
}
const cardsOf = new WeakMap<object, { content: string }[]>();
/** the html of the last card saved through a cardCtx */
const lastCard = (ctx: object) => cardsOf.get(ctx)?.at(-1)?.content ?? "";
/** the row names a drawn rows card shows */
/** a card's html with the name's glued runs and break boxes (gluedHtml) taken out: the text as written */
const unglue = (html: string) => html.replace(/<span class="t-brk"><\/span>/g, "").replace(/<span class="t-glue">([^<]*)<\/span>/g, "$1");
const namesOn = (html: string) =>
  [...unglue(html).matchAll(/<div class="t"><b>([^<]*)<\/b>/g)].map((m) => m[1]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));

describe("exploreIntent", () => {
  const yes = [
    "일본 마운자로 살 수 있는 곳 중에서 연락해줄 수 있는 곳을 전부 찾아줘",
    "성수동에서 1:1 필라테스 체험 가능한 곳 연락처 전부",
    "도쿄에서 한국어 되는 치과",
    "위고비 처방 가능한 병원 알려줘",
    "홍대 근처 단체 예약 되는 식당 찾아줘",
    "이 부품 파는 곳 알아봐 줘",
    "강남에서 아이폰 액정 수리 어디서 해?",
    "마운자로 어디서 살 수 있어?",
    "부산 오션뷰 카페 전부 찾아줘",
    "도쿄·오사카 피부과 20곳 가격순 카드로",
    "강남 피부과 리프팅 가격 비교",
    "서울 필라테스 가격순 목록",
    "무선 이어폰 가격 비교해줘",
    "오사카 이자카야 순위",
  ];
  const no = [
    "오늘 날씨 어때?",
    "내가 사는 곳 날씨 알려줘",
    "오늘 뉴스 한 줄로",
    "원달러 환율 알려줘",
    "엄마 전화번호 찾아줘",
    "카톡에서 엄마가 보낸 사진 찾아줘",
    "이번 주 일정 다 알려줘",
    "회의록 정리해줘",
    "강남역 가는 길 알려줘",
    "이번 주 일정 목록",
    "메일 3개 요약해줘",
    "할 일 목록 정리해줘",
    "회의록 두 개 비교해줘",
    "두 문장 비교해 줘",
    "카톡 대화 10개 보여줘",
    "환율 비교해줘",
    "3개월 뒤가 몇 월이야?",
    "안녕!",
    "",
  ];
  for (const t of yes) test(`yes: ${t}`, () => expect(exploreIntent(t)).toBe(true));
  for (const t of no) test(`no: ${t || "(empty)"}`, () => expect(exploreIntent(t)).toBe(false));
  test("null", () => expect(exploreIntent(null)).toBe(false));

  // '전부, 다, 모두, 빠짐없이, 싹 다, 하나도 빼지 말고' over places or a list of them, whatever the verb or none (11-17: the
  // four first ones went to a plain turn, no round-up read on, no list card)
  const all = [
    "일본 마운자로 병원 전부 보여줘",
    "오사카 마운자로 병원 다 알려줘",
    "일본 마운자로 병원 빠짐없이",
    "일본 전국 마운자로 병원 전부 카드로",
    "도쿄 마운자로 클리닉 전부 표로",
    "후쿠오카 피부과 모두",
    "서울 24시 약국 싹 다 보여줘",
    "강남 필라테스 스튜디오 하나도 빼지 말고 알려줘",
    "부산 오션뷰 호텔 모든 곳",
    "제주 애견 동반 펜션 남김없이 정리",
    "성수동 카페 리스트 전부",
    "오사카 한국어 되는 치과 하나도 빠짐없이",
    "교토 료칸 전체 목록",
    "나고야 마운자로 처방 의원 모조리",
    "도쿄 다이어트 클리닉 몽땅 보여줘",
    "일본 GLP-1 처방하는 곳 죄다 알려줘",
    "삿포로 한인 민박 숙소 전부",
    "지하철역 근처 마운자로 병원 전부", // '지하철' alone is an everyday lookup (SIMPLE)
    "무료 취소 가능한 오사카 호텔 전부", // '취소 가능한' is a find; '취소해 줘' is not
    "카톡 상담 되는 마운자로 병원 다 보여줘",
    "이 곳 근처 맛집 전부 알려줘",
    "일본 마운자로 병원 정리 사이트 전부",
    "후기 별로인 데 빼고 오사카 피부과 전부 보여줘", // a word about them, with a word that asks
    "메일 상담 병원 전부 알려줘", // a contact means, not the owner's mail right next to the all word
    "도쿄 치과 목록 전부 보여줘", // the words the line after a card not for '전부' suggests (allAgain)
    "목록 전부 보여줘",
    "東京のマンジャロ処方クリニックを全部教えて",
    "大阪の皮膚科をすべてリストにして",
    "福岡のマンジャロ取扱い病院を漏れなく",
    "list all mounjaro clinics in Japan",
    "show me every dermatology clinic in Osaka",
    "full list of pharmacies in Shinjuku",
    // any noun asked for in full, not only the place words (PLACE is a closed list)
    "주변 편의점 다 찾아줘",
    "근처 편의점 전부 알려줘",
    "강남 편의점 전부 알려줘",
    "우리 동네 세탁소 전부 알려줘",
    "강남역 근처 주차장 다 찾아줘",
    "부산 해수욕장 다 알려줘",
    "제주도 오름 전부 알려줘",
    "서울 무료 전시회 전부 알려줘",
    "성수동 팝업스토어 전부", // no word that asks: the all word ends the request
    "강남역 근처 주차장 전부 알려줘",
    "판교 공유 오피스 다 알려줘",
    "간 이식 병원 전부 알려줘", // '간' the organ, not 'went to'
    "한 번도 가 본 적 없는 서울 명소 전부 알려줘",
    "산 위에서 야경 보기 좋은 곳 전부 알려줘", // '위에서' a place, not 'said above'
    "방금 오픈한 팝업스토어 전부 알려줘",
    "이 링크에 있는 병원 전부 정리해줘",
    "近くのコンビニ全部教えて",
    "find all parking near gangnam station",
    "전시 내용 좋은 미술관 전부 알려줘", // '내용' not next to the all word
    "통장 개설 되는 은행 전부 알려줘", // money words only next to it ('카드값 다')
    "포인트 적립되는 주유소 전부 알려줘",
    "택배 보낼 수 있는 편의점 전부 알려줘",
    "아까 말한 강남역 근처 주차장 말고 다른 데 전부 찾아줘", // something else asked for
  ];
  // the owner's own things read or cleared in full, a thing to do to places, done, a question about them, and words
  // that only look like '다', '모두', '전부'
  const notAll = [
    "메일 전부 읽어줘",
    "안 읽은 메시지 다 보여줘",
    "이번 주 일정 모두 보여줘",
    "알림 전부 지워줘",
    "다운로드 파일 다 삭제해",
    "병원 관련 메일 전부 찾아줘",
    "다음 주 병원 일정 전부 보여줘",
    "이번 주 회의 장소 전부 알려줘",
    "약국 영수증 전부 정리해줘",
    "식당 결제 내역 전부 보여줘",
    "장바구니 상품 전부 삭제",
    "재생 목록 전부 틀어줘",
    "할 일 목록 전부 보여줘",
    "치과 예약 전부 취소해줘",
    "모두에게 병원 위치 보내줘",
    "모두에게 병원 위치 알려줘",
    "오늘 뉴스 전부 보여줘",
    "그거 다 알려줘",
    "카톡으로 병원 목록 다 보내줘",
    "숙제 다 했어",
    "카페에서 숙제 다 했어",
    "숙소 전부 예약했어",
    "다음 병원 예약 언제야?",
    "다른 병원 알려줘",
    "내가 저장한 맛집 전부 보여줘",
    "찜한 카페 다 보여줘",
    "예약한 식당 전부 보여줘",
    "그 식당 메뉴 전부 알려줘",
    "병원비 전부 실비 돼?",
    "도쿄 병원 전부 비싸?",
    "모든 곳에서 와이파이 돼?",
    "예전부터 다니던 병원 어디였지",
    "모두투어 호텔 패키지 가격",
    "メールを全部削除して",
    "通知をすべて消して",
    "delete all my emails",
    "mark all messages as read",
    "send this to everyone",
    "show all my saved restaurants",
    // the conversation itself or this assistant: no search
    "아까 말한 거 다 알려줘",
    "위 내용 전부 정리해줘",
    "방금 말한 병원 전부 정리해줘",
    "네가 말한 곳 전부 다시 알려줘",
    "위에 나온 거 다 정리해줘",
    "답 전부 다시 보여줘",
    "요약 전부 보여줘",
    "아까 그 카페들 전부 정리해줘",
    "전에 찾아준 거 전부 다시 보여줘",
    "할 수 있는 거 전부 알려줘",
    "아까 말한 거 빼고 전부 다시 정리해줘",
    "네가 어제 말한 그 동네 약국들 전부 다시 알려줘",
    "그거 중에 싼 거 전부 알려줘",
    "이거 관련된 거 전부 찾아줘",
    // where they have been, what they remember
    "어제 간 식당 전부 기억나?",
    "어제 간 곳 전부 알려줘",
    "지난주에 가 본 카페 전부 알려줘",
    "부모님이랑 다녀온 식당 전부 알려줘",
    "여행 중에 먹은 음식 전부 정리해줘",
    "엄마가 좋아하던 식당 전부 기억나?",
    // knowledge or a text, an everyday lookup, the owner's own, nothing named, a thank-you
    "장단점 다 알려줘",
    "마운자로 부작용 전부 알려줘",
    "엑셀 단축키 전부 알려줘",
    "아이유 좋은날 가사 전부 알려줘",
    "서울 지하철 노선 전부 알려줘",
    "카톡 전부 읽어줘",
    "내 주식 전부 보여줘",
    "이번 달 카드값 다 알려줘",
    "우리 회사 직원 전부 알려줘",
    "다 보여줘",
    "아 진짜 다 찾아줘",
    "모두 고마워",
    "다 알려줘서 고마워",
    "tell me all about kyoto",
  ];
  for (const t of all) test(`all: ${t}`, () => expect([exploreIntent(t), exploreHints(t).exhaustive]).toEqual([true, true]));
  for (const t of notAll) test(`not all: ${t}`, () => expect(exploreIntent(t)).toBe(false));
  test("Japanese place names in kanji are Japan", () => expect(exploreHints("大阪の皮膚科をすべてリストにして").japan).toBe(true));

  test("'전부' over a noun no place word names, around no spot: the model's first step decides (exploreOpen); a place word, a spot or a find verb: a search", () => {
    const open = ["조선 왕 전부 알려줘", "세계 국가 수도 전부 알려줘", "포켓몬 전부 알려줘", "롤 챔피언 전부 알려줘", "서울 무료 전시회 전부 알려줘", "이번 주 개봉 영화 전부 알려줘", "오늘 경기 결과 전부 알려줘", "성수동 팝업스토어 전부"];
    for (const t of open) expect([t, exploreIntent(t), exploreOpen(t)]).toEqual([t, true, true]);
    expect([exploreIntent("역대 회장 전부 알려줘"), exploreOpen("역대 회장 전부 알려줘")]).toEqual([true, true]);
    // a kind of place in a named 시도 or 시·군·구 is a search for places, as a place word makes one
    for (const t of ["강남구 주차장 전부 보여줘", "서울 미술관 전부 알려줘", "양평군 캠핑장 전부 알려줘", "마포구 공원 전부 알려줘", "송파구 마트 전부 알려줘"]) expect([t, exploreIntent(t), exploreOpen(t)]).toEqual([t, true, false]);
    for (const t of ["친구 모임 주차장 전부 알려줘", "역대 회장 전부 알려줘", "마포구 회원 전부 알려줘", "강남구 직원 전부 알려줘"]) expect([t, exploreOpen(t)]).toEqual([t, true]);
    const find = ["강남역 근처 주차장 전부 알려줘", "주변 편의점 다 찾아줘", "우리 동네 세탁소 전부 알려줘", "일본 마운자로 병원 전부 보여줘", "집 근처 헬스장 다 보여줘", "할인 쿠폰 전부 찾아줘", "find all parking near gangnam station", "近くのコンビニ全部教えて", "도쿄·오사카 피부과 20곳 가격순 카드로"];
    for (const t of find) expect([t, exploreIntent(t), exploreOpen(t)]).toEqual([t, true, false]);
    for (const t of ["메일 전부 읽어줘", "아까 말한 거 다 알려줘", "오늘 서울 날씨 어때?"]) expect(exploreOpen(t)).toBe(false);
  });

  test("askedSidos: the 시도 a question names, not inside a word; '경기' and '세종' only with their suffix", () => {
    const of = (t: string) => [...askedSidos(t)];
    expect(of("서울 무료 전시회 전부 알려줘")).toEqual(["서울"]);
    expect(of("서울에서 무료 전시 전부")).toEqual(["서울"]);
    expect(of("서울특별시 공영주차장 전부")).toEqual(["서울"]);
    expect(of("제주도 오름 전부 알려줘")).toEqual(["제주"]);
    expect(of("경기도 캠핑장 전부 알려줘")).toEqual(["경기"]);
    expect(of("서울·부산 공연장 전부")).toEqual(["서울", "부산"]);
    expect(of("충청북도 휴양림 전부")).toEqual(["충북"]);
    expect(of("세종시 맛집 전부 알려줘")).toEqual(["세종"]);
    for (const t of ["오늘 경기 결과 전부 알려줘", "세종 업적 전부 알려줘", "세계대전 영화 전부 알려줘", "부산어묵 맛집 전부", "서울대 근처 카페 전부", "인천공항 주차장 전부", "강남역 근처 주차장 전부 알려줘", "오사카 클리닉 전부"]) expect([t, of(t)]).toEqual([t, []]);
  });

  test("askedGus: the words like a 시·군·구 a question names, no 시도 and none inside a word", () => {
    const of = (t: string) => [...askedGus(t)];
    expect(of("강남구 주차장 전부 알려줘")).toEqual(["강남구"]);
    expect(of("수원시에서 미술관 전부")).toEqual(["수원시"]);
    expect(of("부산 해운대구 횟집 전부")).toEqual(["해운대구"]);
    expect(of("양평군 캠핑장 전부")).toEqual(["양평군"]);
    for (const t of ["서울시 주차장 전부", "강남구청 민원 전부", "고등학교친구 모임 카페 전부", "강남역 근처 주차장 전부 알려줘", "서울 무료 전시회 전부 알려줘"]) expect([t, of(t)]).toEqual([t, []]);
  });

  test("askedStem: the noun the all word is about, a kind-of-place ending off", () => {
    expect(["강남역 근처 주차장 전부 알려줘", "서울 무료 전시회 전부 알려줘", "주변 편의점 다 찾아줘", "주차장을 전부 알려줘", "성수동 팝업스토어 전부", "도쿄 치과 목록 전부 보여줘", "목록 전부 보여줘", "list all clinics"].map(askedStem)).toEqual([
      "주차",
      "전시",
      "편의",
      "주차",
      "팝업스토어",
      "치과",
      "",
      "",
    ]);
  });
});

const ASK_ALL = "일본 마운자로 살 수 있는 곳 중에서 연락해줄 수 있는 곳을 전부 찾아줘";
const PILATES = "성수동에서 1:1 필라테스 체험 가능한 곳 연락처 전부";
const DENTIST = "도쿄에서 한국어 되는 치과";

describe("exploreHints / cardToolOf", () => {
  test("전부 widens the budget; a prescription drug gets the import line; Japan gets Japanese examples", () => {
    const none = { exhaustive: false, regulated: false, japan: false, wanted: null, cardAsked: false, contact: false };
    expect(exploreHints(ASK_ALL)).toEqual({ ...none, exhaustive: true, regulated: true, japan: true, contact: true });
    expect(exploreHints(PILATES)).toEqual({ ...none, exhaustive: true, contact: true });
    expect(exploreHints(DENTIST)).toEqual({ ...none, japan: true });
    expect(exploreHints("홍대 근처 단체 예약 되는 식당 찾아줘")).toEqual(none);
    expect(exploreHints("위고비 처방 가능한 병원 모두 알려줘")).toMatchObject({ exhaustive: true, regulated: true });
    expect(exploreHints(null)).toEqual(none);
    // 10 places or more wanted: the wider budget; "카드로": a card for any number
    expect(exploreHints("도쿄·오사카 피부과 20곳 가격순 카드로")).toEqual({ ...none, exhaustive: true, japan: true, wanted: 20, cardAsked: true });
    expect(exploreHints("강남 피부과 5곳 알려줘")).toEqual({ ...none, wanted: 5 });
    expect(exploreHints("마운자로 3개월 처방 가능한 곳")).toMatchObject({ wanted: null, regulated: true });
  });

  test("the card tool: sys_create_artifact with html when its schema offers it, else table, else none", () => {
    const art = (kinds: string[]) => ({ name: "sys_create_artifact", parameters: { type: "object", properties: { kind: { type: "string", enum: kinds } } } }) as unknown as ToolDef;
    expect(cardToolOf([art(["document", "table", "html"])])).toEqual({ name: "sys_create_artifact", kind: "html" });
    expect(cardToolOf([art(["document", "checklist", "table", "dashboard"])])).toEqual({ name: "sys_create_artifact", kind: "table" });
    expect(cardToolOf([art(["document"])])).toBeNull();
    expect(cardToolOf([])).toBeNull();
  });
});

describe("ExploreTracker", () => {
  const search = { name: "web_search", explore: "search" } as unknown as ToolDef;
  const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
  const res = (...urls: string[]) => ({ ok: true, summary: "", data: { query: "q", results: urls.map((url) => ({ title: url, url, snippet: "s" })) } });

  test("domains: www and case fold; punycode kept", () => {
    expect(domainOf("https://WWW.Example.co.kr/a?b")).toBe("example.co.kr");
    expect(domainOf("https://xn--2o2b11q2e68p.site/")).toBe("xn--2o2b11q2e68p.site");
    expect(domainOf("not a url at all")).toBe("");
    expect(domainOf("ignored", "Shop.JP")).toBe("shop.jp");
  });

  test("the gate needs 3 distinct queries and 2 tools; the budget counts every call and the time", () => {
    const t = new ExploreTracker({ calls: 5, ms: 1000 }, 0);
    t.call(search, "web_search", { query: "マンジャロ 処方" });
    t.call(search, "web_search", { query: "  マンジャロ   処方 " }); // same query
    t.call(search, "web_search", { query: "mounjaro japan clinic" });
    expect(t.gateMet()).toBe(false);
    t.call(read, "web_read", { url: "https://a.jp" });
    expect(t.gateMet()).toBe(false); // 2 queries
    t.call(search, "web_search", { query: "스시자로" });
    expect(t.gateMet()).toBe(true);
    expect(t.spent(10)).toBe(true); // 5 calls
    const u = new ExploreTracker({ calls: 50, ms: 1000 }, 0);
    expect(u.spent(999)).toBe(false);
    expect(u.spent(1000)).toBe(true);
  });

  test("search results are de-duplicated by domain across the turn; reads add theirs", () => {
    const t = new ExploreTracker(undefined, 0);
    const first = t.result(search, res("https://a.jp/1", "https://www.a.jp/2", "https://b.jp"));
    expect((first.data as any).results.map((r: any) => r.url)).toEqual(["https://a.jp/1", "https://b.jp"]);
    expect((first.data as any).duplicates).toEqual({ count: 1, domains: ["a.jp"] });
    t.result(read, { ok: true, summary: "", data: { url: "https://c.jp/contact", contacts: [{ kind: "line", value: "@c" }] } });
    const second = t.result(search, res("https://b.jp/x", "https://c.jp", "https://d.jp"));
    expect((second.data as any).results.map((r: any) => r.url)).toEqual(["https://d.jp"]);
    expect(t.summary()).toMatchObject({ domains: ["a.jp", "b.jp", "c.jp", "d.jp"], pages: 1, contactPages: 1 });
    const failed = { ok: false, summary: "x" };
    expect(t.result(search, failed)).toBe(failed);
  });

  test("platform hosts (blogs, cafés, maps, social) dedupe by page, not by domain; IDN and given domains converge", () => {
    const t = new ExploreTracker(undefined, 0);
    const first = t.result(
      search,
      res("https://blog.naver.com/a/1", "https://m.blog.naver.com/b/2", "https://blog.naver.com/a/1/", "https://www.instagram.com/sushijaro/", "https://shop.tistory.com/3", "https://스시자로.site/"),
    );
    expect((first.data as any).results.map((r: any) => r.url)).toEqual(["https://blog.naver.com/a/1", "https://m.blog.naver.com/b/2", "https://www.instagram.com/sushijaro/", "https://shop.tistory.com/3", "https://스시자로.site/"]);
    expect((first.data as any).duplicates).toEqual({ count: 1, domains: ["blog.naver.com/a/1"] });
    // web_read's contacts come as {phones: [], kakao: [], …}; the IDN read and a search result with a display domain match
    t.result(read, { ok: true, summary: "", data: { url: "https://xn--2o2b11q2e68p.site/contact", domain: "스시자로.site", contacts: { phones: [], kakao: [{ value: "sushijaro", source: "link" }] } } });
    t.result(read, { ok: true, summary: "", data: { url: "https://quiet.jp/", contacts: { phones: [], emails: [] } } });
    const second = t.result(search, { ok: true, summary: "", data: { results: [{ url: "https://xn--2o2b11q2e68p.site/menu", domain: "스시자로.site" }, { url: "https://blog.naver.com/c/9" }] } });
    expect((second.data as any).results.map((r: any) => r.url)).toEqual(["https://blog.naver.com/c/9"]);
    expect(t.summary()).toMatchObject({ pages: 2, contactPages: 1 });
    expect(siteKey("not a url", "Naver Blog")).toBe("");
    expect(domainOf("https://WWW.Example.JP./x")).toBe("example.jp");
  });

  test("전부 in text: 40 calls, 180 s, 4 queries, 32 steps; a call keeps 12 / 60 s and makes no card; limits override", () => {
    const card = { name: "sys_create_artifact", kind: "html" as const };
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card });
    expect(t.opts).toEqual(EXHAUSTIVE_SEARCH_DEFAULTS);
    expect(t.maxSteps).toBe(32);
    expect(t.card).toEqual(card);
    const v = new ExploreTracker(undefined, 0, "voice", { text: ASK_ALL, card });
    expect(v.opts).toMatchObject({ calls: 12, ms: 60_000, minQueries: 3 });
    expect(v.maxSteps).toBe(16);
    expect(v.card).toBeNull();
    expect(new ExploreTracker({ calls: 5, exhaustive: { calls: 7 } }, 0, "text", { text: ASK_ALL }).opts.calls).toBe(7);
    expect(new ExploreTracker({ calls: 5, exhaustive: { calls: 7 } }, 0, "text", { text: DENTIST }).opts.calls).toBe(5);
  });

  test("the card call doesn't count as a search tool; the card step is offered once, only when no card was made", () => {
    const card = { name: "sys_create_artifact", kind: "table" as const };
    const t = new ExploreTracker(undefined, 0, "text", { text: DENTIST, card });
    t.call(search, "web_search", { query: "q1" });
    const art = { name: "sys_create_artifact" } as unknown as ToolDef;
    t.call(art, "sys_create_artifact", { title: "x" });
    expect(t.summary()).toMatchObject({ calls: 2, tools: ["web_search"], cardMade: true });
    // a card that failed is no card: the card step stays open
    t.result(art, { ok: false, summary: "너무 커요" });
    expect(t.cardOk()).toBe(false);
    t.result(art, { ok: true, summary: "만들었어요" });
    expect(t.cardOk()).toBe(true);
    expect(t.takeCardStep()).toBe(false);
    const u = new ExploreTracker(undefined, 0, "text", { text: DENTIST, card });
    expect(u.takeCardStep()).toBe(true);
    expect(u.takeCardStep()).toBe(false);
    expect(new ExploreTracker(undefined, 0, "text", { text: DENTIST }).takeCardStep()).toBe(false);
  });

  test("the html design guide (server's lazy guide: content \"\" → ok with data.guide) is no card and, once per turn, gives its card step back", () => {
    const card = { name: "sys_create_artifact", kind: "html" as const };
    const art = { name: "sys_create_artifact" } as unknown as ToolDef;
    const guide = { ok: true, summary: "화면 가이드를 확인했어요", data: { guide: "GUIDE", message: 'Design guide for kind "html". Now call sys_create_artifact again with kind "html", a title and a fragment that follows it.' } };
    const t = new ExploreTracker(undefined, 0, "text", { text: DENTIST, card });
    expect(t.takeCardStep()).toBe(true);
    for (const content of ["", ".", "placeholder"]) expect(t.hold(art, { title: "x", kind: "html", content })).toBeNull(); // never held as a short card
    t.call(art, "sys_create_artifact", { title: "x", kind: "html", content: "" });
    expect(t.summary().cardMade).toBe(false);
    expect(t.shape(art, { kind: "html", content: "." })).toEqual({ kind: "html", content: "." });
    t.result(art, guide);
    expect(t.cardOk()).toBe(false);
    expect(t.tookGuide()).toBe(true);
    expect(t.tookGuide()).toBe(false);
    expect(t.takeCardStep()).toBe(true); // given back
    // a second guide in the same turn is not given back
    t.call(art, "sys_create_artifact", { title: "x", kind: "html" });
    t.result(art, guide);
    expect(t.cardOk()).toBe(false);
    expect(t.tookGuide()).toBe(false);
    expect(t.takeCardStep()).toBe(false);
    // the card after the guide counts as before
    t.call(art, "sys_create_artifact", { title: "x", kind: "html", content: "<ul><li>A</li></ul>" });
    expect(t.summary().cardMade).toBe(true);
    t.result(art, { ok: true, summary: "'x' 화면을 만들었어요", data: { artifactId: "a1" } });
    expect(t.cardOk()).toBe(true);
  });

  test("notes follow the request: round-up sites first, Japanese examples for Japan, the import line only for regulated items, the card", () => {
    const html = { name: "sys_create_artifact", kind: "html" as const };
    const all = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: html }).note(0, "start");
    expect(all).toContain("'전부 / 빠짐없이'");
    expect(all).toContain("정리 사이트부터");
    expect(all).toContain("処方 クリニック 料金 比較");
    expect(all).toContain("個人輸入");
    expect(all).toContain("반입 기준(처방전·수량)");
    // 전부 with a card: the card comes after the answer, laid out in its own step
    expect(all).toContain("카드는 답한 뒤에 모시가 이어서 만들어요");
    expect(all).not.toContain("답하기 전에");
    expect(new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: html }).note(0, "card")).toContain('kind "html"');
    expect(all).toContain("도구 호출 40회, 약 180초");
    expect(all).toContain("답에서 말하는 수는 찾은 곳 전체예요");
    expect(new ExploreTracker(undefined, 0, "text", { text: DENTIST }).note(0, "start")).not.toContain("찾은 곳 전체예요");
    const pil = new ExploreTracker(undefined, 0, "text", { text: PILATES }).note(0, "start");
    expect(pil).not.toContain("処方");
    expect(pil).not.toContain("반입 기준");
    expect(pil).toContain("하나도 빼지 않고 한 줄씩");
    const den = new ExploreTracker(undefined, 0, "text", { text: DENTIST, card: { name: "sys_create_artifact", kind: "table" } }).note(0, "start");
    expect(den).toContain("일본어 예");
    expect(den).not.toContain("반입 기준");
    expect(den).toContain('kind "table"');
    expect(den).toContain("도구 호출 12회");
    const derm = new ExploreTracker(undefined, 0, "text", { text: "도쿄·오사카 피부과 20곳 가격순 카드로", card: html });
    expect(derm.opts.calls).toBe(40);
    expect(derm.note(0, "start")).toContain("요청한 수: 20곳");
    expect(derm.note(0, "start")).toContain("'확인 안 됨'");
    expect(derm.note(0, "start")).toContain("카드는 답한 뒤에");
    expect(derm.cardLate).toBe(true);
    expect(den.includes("카드는 답한 뒤에")).toBe(false); // the dentist's card (if any) is the model's call, as before
    expect(derm.note(0, "start")).not.toContain("반입 기준");
    const fin = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: html });
    expect(fin.note(0, "final", true)).toContain("지금 sys_create_artifact로 전체 목록 카드를 만들고");
    expect(fin.note(0, "final")).toContain("도구를 더 부르지 말고");
    // card step spent without a card: list everything in words, never "make a card" with tools off
    expect(fin.note(0, "final")).toContain("카드 도구는 이제 쓸 수 없어요");
    expect(fin.note(0, "final")).not.toContain("답하기 전에");
    // card made: never ask for another (the derm probe wrote a second one as DSML, twice)
    fin.call({ name: "sys_create_artifact" } as unknown as ToolDef, "sys_create_artifact", { kind: "html" });
    fin.result({ name: "sys_create_artifact" } as unknown as ToolDef, { ok: true, summary: "만들었어요" });
    for (const ph of ["progress", "final"] as const) {
      expect(fin.note(0, ph)).toContain("카드는 이미 만들었어요");
      expect(fin.note(0, ph)).not.toContain("답하기 전에");
    }
    expect(fin.emptyReply()).toBe(CARD_DONE_REPLY);
    expect(new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: html }).emptyReply()).toBeNull();
  });

  test("late card: lists read are named in the card note with their size; once, only with something to list", () => {
    const html = { name: "sys_create_artifact", kind: "html" as const };
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: html });
    expect(t.cardLate).toBe(true);
    expect(t.takeLateCard()).toBe(false); // nothing found yet
    const items = Array.from({ length: 57 }, (_, i) => ({ name: `병원 ${i}`, url: `https://aitoolog.com/clinics/${i}` }));
    t.result(read, { ok: true, summary: "읽음", data: { url: "https://aitoolog.com/clinics", title: "스시자로 병원 찾기 125곳", items, itemsTotal: 125, nextItemsFrom: 57 } });
    t.result(read, { ok: true, summary: "읽음", data: { url: "https://aitoolog.com/clinics", title: "스시자로 병원 찾기 125곳", items: items.slice(0, 5), itemsTotal: 125, itemsFrom: 57 } });
    t.result(read, { ok: true, summary: "읽음", data: { url: "https://small.example.jp/", title: "세 곳", items: items.slice(0, 3), itemsTotal: 3 } });
    expect(t.lists()).toEqual([{ url: "https://aitoolog.com/clinics", site: "aitoolog.com", title: "스시자로 병원 찾기 125곳", total: 125 }]);
    const card = t.note(0, "card");
    expect(card).toContain("[카드 만들기] 답은 이미 했어요");
    expect(card).toContain("aitoolog.com '스시자로 병원 찾기 125곳' 125개");
    expect(card).toContain('행은 모두 이 모양으로 써요(설명·중첩 목록 없이): <div class="d"> 안에 <a href="https://…"><b>이름</b><em>가격</em><small>지역 · 연락 수단 하나</small></a>');
    expect(card).toContain("그 요약 줄은 .d 안 마지막에 쓰고 order:-1을 주면 목록 위에 보여요");
    expect(card).not.toContain("확인 안 됨");
    expect(card).not.toContain("<li><a");
    expect(card).toContain(`카드 하나는 ${CARD_MAX_ROWS}행까지`);
    t.cardWasCut();
    expect(t.note(0, "card")).toContain("길이 제한에 걸려 잘렸어요");
    expect(t.takeLateCard("250곳이 넘어요")).toBe(true);
    expect(t.cardTarget()).toBe(CARD_MAX_ROWS);
    // with rows (card_rows): no 120 cap, and at least the places of the lists read
    const rt = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: html });
    rt.rowsTool({ name: "sys_create_artifact", run: async () => ({ ok: true, summary: "" }) } as unknown as ToolDef);
    const linked = Array.from({ length: 30 }, (_, i) => ({ name: `병원 ${i}`, key: `병원${i}`, url: `https://aitoolog.com/clinics/${i}` }));
    rt.result(read, { ok: true, summary: "", data: { url: "https://aitoolog.com/clinics", items: [...linked, { name: "메뉴", key: "메뉴" }], itemsTotal: 31 } });
    expect(rt.listPlaces()).toBe(30); // the menu line links nowhere
    expect(rt.takeLateCard("12곳을 찾았어요")).toBe(true);
    expect(rt.cardTarget()).toBe(30);
    expect(rt.note(0, "progress")).toContain("읽은 목록에 나온 곳만 같은 곳을 묶어 30곳이에요");
    expect(card).toContain("반입 기준");
    expect(card).not.toContain("답 형식");
    expect(t.note(0, "final", true)).toContain("125개");
    expect(t.cardRequired()).toBe(true);
    expect(t.takeLateCard()).toBe(false); // taken above
    expect(t.takeCardStep()).toBe(false);
    // not late: a plain find keeps the model's own card call
    const p = new ExploreTracker(undefined, 0, "text", { text: DENTIST, card: html });
    expect(p.cardLate).toBe(false);
    expect(p.takeLateCard()).toBe(false);
    // asked for a card: late even with few places
    const c = new ExploreTracker(undefined, 0, "text", { text: "도쿄·오사카 피부과 20곳 가격순 카드로", card: html });
    expect(c.takeLateCard()).toBe(true);
  });

  test("placeholder phones: 0000 runs and '임시번호' are said as unknown; real numbers stay", () => {
    for (const p of ["02-0000-0000", "010-0000-0000", "0120-000-000", "000-000-0000", "03-1111111", "1234-5678-90"]) expect(isPlaceholderPhone(p)).toBe(true);
    for (const p of ["03-1234-0000", "06-6786-8880", "0120-151-929", "+81 3-3770-3388", "2026.11.15"]) expect(isPlaceholderPhone(p)).toBe(false);
    expect(scrubPlaceholderPhones("필라테스A 02-0000-0000(임시번호) · 체험 2만원")).toBe("필라테스A 확인 안 됨 · 체험 2만원");
    expect(scrubPlaceholderPhones("B 02-555-1234 (임시번호), C 06-6786-8880, 2026.11.15 기준")).toBe("B 확인 안 됨, C 06-6786-8880, 2026.11.15 기준");
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const t = new ExploreTracker(undefined, 0, "text", { text: PILATES });
    const out = t.result(read, {
      ok: true,
      summary: "",
      data: {
        url: "https://pilates.example.kr/",
        text: "문의 02-0000-0000",
        contacts: { phones: [{ value: "02-0000-0000", source: "text" }, { value: "02-498-2276", source: "link" }], emails: [] },
        items: [{ name: "필라테스A", key: "필라테스a", tel: "0200000000", text: "성수 · 02-0000-0000(임시번호)", contacts: ["02-0000-0000", "kakao:abc"] }],
      },
    });
    const data = out.data as any;
    expect(data.text).toBe("문의 확인 안 됨");
    expect(data.contacts.phones.map((c: any) => c.value)).toEqual(["02-498-2276"]);
    expect(data.items[0].tel).toBeUndefined();
    expect(data.items[0].text).toBe("성수 · 확인 안 됨");
    expect(data.items[0].contacts).toEqual(["kakao:abc"]);
    const clean = { ok: true, summary: "", data: { url: "https://x.example.kr/", text: "06-6786-8880" } };
    expect(t.result(read, clean)).toBe(clean); // nothing to take out: the same object
  });

  test("a page priced in a drug the question doesn't name is flagged; sources are read first; same places by tel / key+area", () => {
    const html = { name: "sys_create_artifact", kind: "html" as const };
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const derm = new ExploreTracker(undefined, 0, "text", { text: "도쿄·오사카 피부과 20곳 가격순 카드로", card: html });
    const off = derm.result(read, {
      ok: true,
      summary: "",
      data: { url: "https://excelkospi.ai/mounjaro", title: "일본 마운자로 가격 · 도쿄·오사카 병원 공식 가격 비교", text: "2.5mg ¥9,800~¥33,000", items: [{ name: "시마다 내과", key: "시마다내과", text: "신주쿠 · 13,600엔 · 진찰 0円" }] },
    });
    expect((off.data as any).text).toBe("2.5mg (다른 품목 가격)");
    expect((off.data as any).items[0].text).toBe("신주쿠 · (다른 품목 가격) · 진찰 (다른 품목 가격)");
    expect(derm.note(0, "card")).toContain("주제가 다른 가격 페이지: excelkospi.ai('마운자로')");
    // its list is not offered as the list to copy; an on-topic list still is
    const items = Array.from({ length: 20 }, (_, i) => ({ name: `C${i}`, key: `c${i}` }));
    derm.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro/tokyo", title: "도쿄 마운자로 가격 비교", items, itemsTotal: 268 } });
    derm.result(read, { ok: true, summary: "", data: { url: "https://glownavi.com/pico-cheap/", title: "東京でピコトーニングが安いクリニック10選", items, itemsTotal: 40 } });
    expect(derm.lists().map((l) => l.site)).toEqual(["excelkospi.ai", "glownavi.com"]);
    expect(derm.note(0, "card")).toContain("읽은 목록: glownavi.com");
    expect(derm.note(0, "card")).not.toContain("268개");
    expect(derm.note(0, "progress")).toContain("(다른 품목 가격)'으로 가렸어요");
    const mj = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: html });
    const on = mj.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro", title: "일본 마운자로 가격 비교", text: "¥9,800" } });
    expect((on.data as any).text).toBe("¥9,800");
    expect(mj.note(0, "card")).not.toContain("주제가 다른");
    // a round-up naming its source: that site goes first in the progress note, until read
    mj.result(read, { ok: true, summary: "", data: { url: "https://aitoolog.com/clinics", title: "스시자로 총정리", sources: [{ label: "스시자로", url: "https://xn--2o2b11q2e68p.site/" }] } });
    expect(mj.note(0, "progress")).toContain("출처로 밝힌 사이트(아직 안 엶): 스시자로.site ('스시자로')");
    mj.result(read, { ok: true, summary: "", data: { url: "https://xn--2o2b11q2e68p.site/", title: "스시자로" } });
    expect(mj.note(0, "progress")).not.toContain("출처로 밝힌 사이트");
    // same places across pages
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: html });
    t.result(read, { ok: true, summary: "", data: { url: "https://a.example/list", items: [
      { name: "고토 의원", key: "고토後藤", tel: "0666565031" },
      { name: "마루 클리닉 나고야", key: "마루", area: "名古屋市中区" },
      { name: "미라이 메디컬", key: "미라이", url: "https://miraimedical.com/kr" },
      { name: "가짜 클리닉", key: "가짜", tel: "0600000000" },
      { name: "혼자", key: "혼자" },
    ] } });
    t.result(read, { ok: true, summary: "", data: { url: "https://b.example/list", items: [
      { name: "後藤医院", key: "後藤", tel: "0666565031" },
      { name: "마루 클리닉 오사카", key: "마루", area: "大阪市北区" },
      { name: "미라이 클리닉", key: "미라이", url: "https://miraimedical.com/" },
      { name: "가짜 의원", key: "가짜2", tel: "0600000000" },
      { name: "혼자", key: "혼자", url: "https://other.example/" },
    ] } });
    const groups = t.sameGroups();
    expect(groups).toContainEqual({ names: ["고토 의원", "後藤医院"], why: "tel" });
    expect(groups).toContainEqual({ names: ["미라이 메디컬", "미라이 클리닉"], why: "site" });
    expect(groups.some((g) => g.names.includes("마루 클리닉 나고야"))).toBe(false); // the same name in two cities
    expect(groups.some((g) => g.names.includes("가짜 클리닉"))).toBe(false); // a placeholder tel joins nothing
    expect(groups.some((g) => g.names.includes("혼자"))).toBe(false); // the name alone
    const card = t.note(0, "card");
    expect(card).toContain("같은 곳(한 행으로만 써요): '고토 의원' = '後藤医院' (같은 전화)");
    expect(card).toContain("곳 수는 머리에 쓰지 않아요");
    expect(card).toContain(`곳 수는 숫자 대신 ${CARD_COUNT_TOKEN}로 써요`);
    expect(card).toContain("자리표시 번호");
  });

  test("전부: the gate also wants half the budget in calls", () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    for (let i = 0; i < 4; i++) t.call(search, "web_search", { query: `q${i}` });
    t.call(read, "web_read", { url: "https://a.jp" });
    expect(t.gateMet()).toBe(false); // 5 calls of 20
    expect(t.note(0, "progress")).toContain("도구 호출 20회 이상");
    for (let i = 0; i < 15; i++) t.call(read, "web_read", { url: `https://a${i}.jp` });
    // 전부 + 연락: three pages with contacts too
    expect(t.gateMet()).toBe(false);
    expect(t.note(0, "progress")).toContain("연락처가 나온 페이지가 아직 0곳이에요");
    for (let i = 0; i < 3; i++) t.result(read, { ok: true, summary: "", data: { url: `https://a${i}.jp/`, contacts: [{ kind: "phone", value: "03-3770-338" + i }] } });
    expect(t.gateMet()).toBe(true);
    expect(t.note(0, "progress")).not.toContain("연락처가 나온 페이지가 아직");
    // no contact asked: calls alone
    const u = new ExploreTracker(undefined, 0, "text", { text: "도쿄 라멘집 전부 찾아줘" });
    for (let i = 0; i < 4; i++) u.call(search, "web_search", { query: `q${i}` });
    for (let i = 0; i < 16; i++) u.call(read, "web_read", { url: `https://a${i}.jp` });
    expect(u.gateMet()).toBe(true);
    expect(new ExploreTracker({ calls: 5 }, 0, "text", { text: DENTIST }).opts.minCalls).toBe(0);
  });

  test("round-up sites in search results (a listing path or wording) are named in the progress note until read", () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    t.result(search, {
      ok: true,
      summary: "",
      data: {
        results: [
          { title: "MIL CLINIC OSAKA · 大阪 | Sushijaro", url: "https://sushijaro.kr/ja/clinics/mil-clinic-osaka" },
          { title: "일본 마운자로 병원 가격 비교 125곳", url: "https://aitoolog.com/stats" },
          { title: "마운자로 후기", url: "https://blog.naver.com/x/1" }, // a platform: never a candidate
          { title: "MIL CLINIC", url: "https://mil-clinic.com/lp/mounjaro-kr/" }, // a clinic's own page
        ],
      },
    });
    // the biggest named count first ('125곳'), then the directory paths
    expect(t.roundups().map((u) => u.site)).toEqual(["aitoolog.com", "sushijaro.kr"]);
    // kept by the directory page: the page itself, or the list above an entry page ('/ja/clinics/<one>' → '/ja')
    expect(t.roundups().map((u) => u.url)).toEqual(["https://aitoolog.com/stats", "https://sushijaro.kr/ja"]);
    expect(t.note(0, "progress")).toContain("아직 안 연 정리 사이트 후보: aitoolog.com ('일본 마운자로 병원 가격 비교 125곳'), sushijaro.kr ('MIL CLINIC OSAKA · 大阪 | Sushijaro')");
    // another page of the site with no big list leaves it open; the directory page (or a big list there) opens it
    t.call(read, "web_read", { url: "https://sushijaro.kr/ja/clinics/mil-clinic-osaka" });
    t.result(read, { ok: true, summary: "", data: { url: "https://sushijaro.kr/ja/clinics/mil-clinic-osaka", title: "MIL CLINIC OSAKA", contacts: {} } });
    expect(t.roundups().map((u) => u.site)).toEqual(["aitoolog.com", "sushijaro.kr"]);
    t.result(read, { ok: true, summary: "", data: { url: "https://sushijaro.kr/ja/", contacts: {} } });
    expect(t.roundups().map((u) => u.site)).toEqual(["aitoolog.com"]);
    t.result(read, { ok: true, summary: "", data: { url: "https://aitoolog.com/tokyo", title: "도쿄 마운자로 병원 80곳", text: "…" } });
    expect(t.roundups()).toEqual([]);
    // IDN: 스시자로.site's results name it in Hangul
    t.result(search, { ok: true, summary: "", data: { results: [{ title: "스시자로 — 일본 마운자로 병원 가격 비교", url: "https://xn--2o2b11q2e68p.site/" }] } });
    expect(t.note(0, "progress")).toContain("스시자로.site ('스시자로 — 일본 마운자로 병원 가격 비교')");
  });

  test("round-ups past twelve: a bigger one takes the smallest one's place; on one site the bigger wins; an entry page read leaves its directory a lead", () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    const found = (results: { title: string; url: string }[], x = t) => x.result(search, { ok: true, summary: "", data: { results } });
    found(Array.from({ length: 12 }, (_, i) => ({ title: i ? `マンジャロ おすすめ ${i + 3}選 比較` : "マンジャロ クリニック 15院 比較", url: `https://col${i}.jp/column/m/` })));
    expect(t.roundups()).toHaveLength(12);
    // a 430-place directory from a later search: in, in place of the smallest; one no bigger than the smallest: out
    found([{ title: "일본 마운자로 성지·가격 비교 | 병원 430곳", url: "https://excelkospi.ai/mounjaro" }, { title: "マンジャロ 比較", url: "https://col99.jp/c/" }]);
    const ups = t.roundups();
    expect(ups).toHaveLength(12);
    expect(ups[0]).toEqual({ site: "excelkospi.ai", url: "https://excelkospi.ai/mounjaro", title: "일본 마운자로 성지·가격 비교 | 병원 430곳" });
    expect(ups[1]!.site).toBe("col0.jp"); // the 15院 one stays (bigger than the picks)
    expect(ups.map((u) => u.site)).not.toContain("col99.jp");
    expect(ups.map((u) => u.site)).not.toContain("col1.jp"); // the first of the smallest made room
    // one site: the bigger wins, a smaller one later doesn't take it back
    const g = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    found([{ title: "マンジャロ 比較", url: "https://dir.jp/a" }], g);
    found([{ title: "全国 マンジャロ 一覧 665院", url: "https://dir.jp/all" }], g);
    found([{ title: "マンジャロ 比較 8選", url: "https://dir.jp/b" }], g);
    expect(g.roundups()).toEqual([{ site: "dir.jp", url: "https://dir.jp/all", title: "全国 マンジャロ 一覧 665院" }]);
    // a big list read on a site: its other round-ups are not leads any more
    g.result(read, { ok: true, summary: "", data: { url: "https://dir.jp/all", title: "全国 一覧665院", items: Array.from({ length: 30 }, (_, i) => ({ name: `D${i}`, key: `d${i}` })), itemsTotal: 30 } });
    found([{ title: "大阪 マンジャロ 一覧 85院", url: "https://dir.jp/osaka" }], g);
    expect(g.roundups()).toEqual([]);
    // an entry page of a directory (the run that read only it): the list above it stays a lead, by that page
    const f = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    const entry = "https://excelkospi.ai/mounjaro/clinic/clinicfor-online";
    found([{ title: "클리닉 포어 온라인 진료 마운자로 가격 · 2.5mg 1개월 34,100엔", url: entry }], f);
    expect(f.roundups().map((u) => u.url)).toEqual(["https://excelkospi.ai/mounjaro"]);
    f.call(read, "web_read", { url: entry });
    f.result(read, { ok: true, summary: "", data: { url: entry, title: "클리닉 포어 온라인 진료", items: [{ name: "A", key: "a" }], itemsTotal: 1 } });
    found([{ title: "클리닉 포어 온라인 진료 마운자로 가격", url: entry }], f); // read: not again
    expect(f.roundups().map((u) => u.url)).toEqual(["https://excelkospi.ai/mounjaro"]);
    expect(f.leadStep(1_000, true)!.note).toContain("https://excelkospi.ai/mounjaro ('클리닉 포어 온라인 진료 마운자로 가격");
    expect(f.cardLine()).toBe("아직 안 본 정리 사이트: excelkospi.ai.");
    // the directory page read (text only): opened, and not a lead again when a later search finds it
    f.call(read, "web_read", { url: "https://excelkospi.ai/mounjaro" });
    f.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro", title: "일본 마운자로", text: "…" } });
    found([{ title: "일본 마운자로 병원 430곳", url: "https://excelkospi.ai/mounjaro" }], f);
    expect(f.roundups()).toEqual([]);
    // an entry page read first, its directory found after: a lead (the site was read, not its list)
    const k = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    k.call(read, "web_read", { url: entry });
    k.result(read, { ok: true, summary: "", data: { url: entry, title: "클리닉 포어 온라인 진료", text: "…" } });
    found([{ title: "일본 마운자로 병원 430곳", url: "https://excelkospi.ai/mounjaro" }], k);
    expect(k.roundups().map((u) => u.url)).toEqual(["https://excelkospi.ai/mounjaro"]);
    // a site known by its front page: any page read opens it (as before)
    const h = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    found([{ title: "일본 마운자로 후기 모음", url: "https://tips.kr/2026/11/post" }], h);
    expect(h.roundups().map((u) => u.url)).toEqual(["https://tips.kr/"]);
    h.call(read, "web_read", { url: "https://tips.kr/2026/11/post" });
    expect(h.roundups()).toEqual([]);
  });

  test("Chinese round-ups: '共有111間', '（140家）', 排名·名單·一覽 titles are round-ups, the counted ones big", () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: "타이베이에서 라식 수술하는 안과 전부 찾아줘" });
    t.result(search, { ok: true, summary: "", data: { results: [
      { title: "臺北市 眼科的診所（140家）｜看診", url: "https://kanzhen.tw/taipei/eye" },
      { title: "臺北市眼科診所共有111間推薦給您-台灣診所網", url: "https://dr.twincn.com/Litem.aspx?a1=臺北市&t=130" },
      { title: "2026 臺北市眼科診所推薦排名 | 醫立查", url: "https://easyfindinfo.com/city_ranking/x" },
      { title: "臺北市政府衛生局-眼科合約醫療院所資訊-最新院所名單", url: "https://health.gov.taipei/eye" },
      { title: "首頁-台全眼科", url: "https://tq-eye.tw/" },
    ] } });
    const ups = t.roundups();
    expect(ups.map((u) => u.site)).toEqual(["kanzhen.tw", "dr.twincn.com", "health.gov.taipei", "easyfindinfo.com"]);
    expect(ups[1]!.url).toBe("https://dr.twincn.com/Litem.aspx?a1=%E8%87%BA%E5%8C%97%E5%B8%82&t=130"); // big: the page itself
    expect(ups[3]!.url).toBe("https://easyfindinfo.com/"); // a ranking without a count: a pick
  });

  test("a big round-up's directory page: the titled page itself; above an entry page, its prefix or else the front page (a made-up '/clinics/' was 404)", () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    t.result(search, { ok: true, summary: "", data: { results: [
      { title: "MIL CLINIC OSAKA · 오사카 | 스시자로", url: "https://sushijaro.kr/clinics/mil-clinic-osaka" },
      { title: "도쿄 마운자로 병원 203곳", url: "https://excelkospi.ai/mounjaro/clinics/tokyo" },
      { title: "Medimee", url: "https://medimee.com/clinic/detail/1701/menu/1618" },
      { title: "일본 병원 찾기 지도", url: "https://map.example.kr/clinics/near/me" },
    ] } });
    expect(Object.fromEntries(t.roundups().map((u) => [u.site, u.url]))).toEqual({
      "sushijaro.kr": "https://sushijaro.kr/",
      "excelkospi.ai": "https://excelkospi.ai/mounjaro/clinics/tokyo",
      "medimee.com": "https://medimee.com/",
      "map.example.kr": "https://map.example.kr/clinics/near/me",
    });
    // a front page lead: any page of the site read opens it
    t.call(read, "web_read", { url: "https://sushijaro.kr/clinics/other" });
    expect(t.roundups().map((u) => u.site)).not.toContain("sushijaro.kr");
  });

  test("전부: a hub of region pages ('도쿄 36개 병원 …'): its count headings are not places, and its region pages are a lead until one is read", () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    const regions = [["도쿄", 36], ["오사카", 14], ["교토", 6], ["고베", 6], ["후쿠오카", 21], ["삿포로", 6]] as const;
    const items = [
      ...regions.map(([r, n]) => ({ name: `${r} ${n}개 병원`, key: `${r}${n}개`, url: `https://aitoolog.com/${r}/` })),
      { name: "대마도 배송·처방 확인", key: "대마도배송처방확인", url: "https://aitoolog.com/tsushima/" },
      { name: "365 클리닉", key: "365", url: "https://365.example.jp/" }, // a name with a number: a place
    ];
    t.result(read, { ok: true, summary: "", data: { url: "https://aitoolog.com/", title: "스시자로 총정리 - 일본 마운자로 처방 병원", items, itemsTotal: items.length } });
    expect(t.listPlaces()).toBe(2);
    expect(t.note(0, "progress")).toContain("목록이 잘린 페이지: https://aitoolog.com/ (지역·분류 페이지 6개에 89곳). 더 있는 목록이에요");
    expect(t.cardLine()).toBe("덜 읽은 정리 사이트: aitoolog.com(지역별 페이지의 89곳).");
    const u = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    u.result(read, { ok: true, summary: "", data: { url: "https://aitoolog.com/", title: "총정리", items, itemsTotal: items.length } });
    u.result(read, { ok: true, summary: "", data: { url: "https://aitoolog.com/도쿄/", title: "도쿄 36개 병원", items: Array.from({ length: 36 }, (_, i) => ({ name: `T${i}`, key: `t${i}` })), itemsTotal: 36 } });
    expect(u.cardLine()).toBeNull();
    // two headings, or headings under half the items, or a sum under 20: a list, not a hub
    for (const its of [items.slice(0, 2), [...items.slice(0, 3), ...Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, key: `p${i}` }))], [{ name: "A 3곳", key: "a" }, { name: "B 4곳", key: "b" }, { name: "C 5곳", key: "c" }]]) {
      const n = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
      n.result(read, { ok: true, summary: "", data: { url: "https://hub.jp/", title: "목록", items: its, itemsTotal: its.length } });
      expect(n.cardLine()).toBeNull();
    }
  });

  test("web_read list pages: items are counted, nextItemsFrom / nextFrom are named until read on; like-searches count as queries", () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    const items = Array.from({ length: 65 }, (_, i) => ({ name: `클리닉 ${i}`, url: `https://스시자로.site/clinic/c${i}` }));
    t.result(read, { ok: true, summary: "", data: { url: "https://스시자로.site/", items: items.slice(0, 40), itemsTotal: 65, nextItemsFrom: 40, contacts: {} } });
    let p = t.note(0, "progress");
    expect(p).toContain("목록 페이지에서 모은 항목 40개");
    expect(p).toContain("https://스시자로.site/ (itemsFrom=40)");
    t.result(read, { ok: true, summary: "", data: { url: "https://스시자로.site/", items: items.slice(40), itemsTotal: 65 } });
    p = t.note(0, "progress");
    expect(p).toContain("항목 65개");
    expect(p).not.toContain("아직 남은 목록");
    expect(t.summary().items).toBe(65);
    t.call(search, "web_search", { like: "https://xn--2o2b11q2e68p.site/" });
    expect(t.summary().queries).toEqual(["like:xn--2o2b11q2e68p.site"]);
    const like = { name: "web_search", explore: "search" } as unknown as ToolDef;
    expect(exploreStatus(like, { like: "https://xn--2o2b11q2e68p.site/" }, "웹 검색")).toBe("스시자로.site 같은 곳 찾는 중");
    expect(exploreStatus(like, {}, "웹 검색")).toBe("웹 검색");
  });

  test("전부: round-ups seen and lists begun are opened before the answer, until 3/4 of the budget", () => {
    const t = new ExploreTracker(undefined, 1_000, "text", { text: "도쿄 라멘집 전부 찾아줘" });
    for (let i = 0; i < 4; i++) t.call(search, "web_search", { query: `q${i}` });
    for (let i = 0; i < 16; i++) t.call(read, "web_read", { url: `https://a${i}.jp` });
    expect(t.gateMet(1_000)).toBe(true);
    t.result(search, { ok: true, summary: "", data: { results: [
      { title: "東京ラーメン 一覧 300件", url: "https://ramen-db.jp/tokyo/" },
      { title: "도쿄 라멘 지도", url: "https://ramen.example.kr/rank" },
      { title: "東京ラーメンおすすめ8選", url: "https://ramen-blog.jp/8" }, // a pick of eight: shown, never held for
    ] } });
    expect(t.roundups().map((u) => u.site)).toEqual(["ramen-db.jp", "ramen.example.kr", "ramen-blog.jp"]);
    expect(t.gateMet(1_000)).toBe(false);
    expect(t.note(1_000, "progress")).toContain("위의 큰 정리 사이트(목록·지도·N곳)와 이어 읽을 목록(2곳)을 먼저 모두 열어요");
    // a read that fails still takes its site off (call() runs before the result)
    t.call(read, "web_read", { url: "https://ramen.example.kr/rank" });
    t.result(read, { ok: false, summary: "403" });
    expect(t.roundups().map((u) => u.site)).toEqual(["ramen-db.jp", "ramen-blog.jp"]);
    // a list begun: read on to the end first
    t.call(read, "web_read", { url: "https://ramen-db.jp/tokyo/" });
    const items = Array.from({ length: 50 }, (_, i) => ({ name: `라멘 ${i}`, key: `라멘${i}` }));
    t.result(read, { ok: true, summary: "", data: { url: "https://ramen-db.jp/tokyo/", title: "東京ラーメン 一覧", items, itemsTotal: 300, nextItemsFrom: 50 } });
    expect(t.roundups().map((u) => u.site)).toEqual(["ramen-blog.jp"]);
    expect(t.gateMet(1_000)).toBe(false);
    expect(t.note(1_000, "progress")).toContain("이어 읽을 목록(1곳)");
    // 3/4 of the time: the answer may come
    expect(t.gateMet(1_000 + 135_000)).toBe(true);
    // 3/4 of the calls too
    for (let i = 0; i < 8; i++) t.call(read, "web_read", { url: `https://b${i}.jp` });
    expect(t.gateMet(1_000)).toBe(true);
    // not '전부': no such hold
    const d = new ExploreTracker(undefined, 1_000, "text", { text: DENTIST });
    for (let i = 0; i < 3; i++) d.call(search, "web_search", { query: `q${i}` });
    d.call(read, "web_read", { url: "https://x.jp" });
    d.result(search, { ok: true, summary: "", data: { results: [{ title: "東京 歯科 一覧", url: "https://dental-db.jp/" }] } });
    expect(d.gateMet(1_000)).toBe(true);
  });

  test("전부: a list web_read cut at its cap (itemsCut) stays a lead until another page of its site is read", () => {
    const t = new ExploreTracker(undefined, 1_000, "text", { text: "도쿄 라멘집 전부 찾아줘" });
    for (let i = 0; i < 4; i++) t.call(search, "web_search", { query: `q${i}` });
    for (let i = 0; i < 16; i++) t.call(read, "web_read", { url: `https://a${i}.jp` });
    expect(t.gateMet(1_000)).toBe(true);
    const items = Array.from({ length: 40 }, (_, i) => ({ name: `라멘 ${i}`, key: `라멘${i}` }));
    const all = "https://ramen-db.jp/all/";
    // its first page: one list to read on (not two)
    t.call(read, "web_read", { url: all });
    t.result(read, { ok: true, summary: "", data: { url: all, title: "ラーメン 一覧", items, itemsTotal: 1000, itemsCut: true, nextItemsFrom: 40 } });
    expect(t.note(1_000, "progress")).toContain("이어 읽을 목록(1곳)");
    // read to the end of the 1000 kept: still open, the rest is on the site's other pages
    t.call(read, "web_read", { url: all, itemsFrom: 960 });
    t.result(read, { ok: true, summary: "", data: { url: all, title: "ラーメン 一覧", items, itemsTotal: 1000, itemsCut: true, itemsFrom: 960 } });
    expect(t.gateMet(1_000)).toBe(false);
    const note = t.note(1_000, "progress");
    expect(note).toContain("이어 읽을 목록(1곳)");
    expect(note).toContain(`목록이 잘린 페이지: ${all} (항목 1000개에서 끊김). 더 있는 목록이에요: 같은 사이트의 지역·분류별 페이지(pageLinks, 목록 항목의 링크)를 더 읽어 나머지를 모아요.`);
    // another site's page leaves it open; a region page of its own site closes it
    t.call(read, "web_read", { url: "https://other.jp/" });
    t.result(read, { ok: true, summary: "", data: { url: "https://other.jp/", text: "…" } });
    expect(t.gateMet(1_000)).toBe(false);
    t.call(read, "web_read", { url: "https://ramen-db.jp/tokyo/shinjuku/" });
    t.result(read, { ok: true, summary: "", data: { url: "https://ramen-db.jp/tokyo/shinjuku/", items: items.slice(0, 20), itemsTotal: 20 } });
    expect(t.gateMet(1_000)).toBe(true);
    expect(t.note(1_000, "progress")).not.toContain("목록이 잘린 페이지");
    // not '전부': said, never held for
    const d = new ExploreTracker(undefined, 1_000, "text", { text: DENTIST });
    for (let i = 0; i < 3; i++) d.call(search, "web_search", { query: `q${i}` });
    d.call(read, "web_read", { url: "https://dental-db.jp/" });
    d.result(read, { ok: true, summary: "", data: { url: "https://dental-db.jp/", items, itemsTotal: 1000, itemsCut: true } });
    expect(d.gateMet(1_000)).toBe(true);
    expect(d.note(1_000, "progress")).toContain("목록이 잘린 페이지: https://dental-db.jp/ (항목 1000개에서 끊김)");
  });

  test("전부: a list read on from web_read's cache (itemsFrom) is outside the call budget; the notes put the list before contact pages", () => {
    const t = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    const items = Array.from({ length: 60 }, (_, i) => ({ name: `C${i}`, key: `c${i}` }));
    const url = "https://excelkospi.ai/mounjaro";
    expect(t.note(1_000, "start")).toContain("5. 정리 사이트의 목록을 끝까지 다 읽은 뒤에 상위 몇 곳만 공식 페이지를 열어 연락처를 확인해요.");
    t.call(read, "web_read", { url });
    expect(t.hold(read, { url })).toBeNull();
    t.result(read, { ok: true, summary: "", data: { url, title: "일본 마운자로 성지", items, itemsTotal: 590, nextItemsFrom: 60 } });
    expect(t.summary().calls).toBe(1);
    const open = t.note(1_000, "progress");
    expect(open).toContain("열린 목록부터 끝까지 읽어요: 같은 주소의 이어 읽기(itemsFrom)는 저장해 둔 페이지에서 읽어서 도구 호출 예산에서 빠져요.");
    expect(open).toContain("이어 읽을 목록(1곳)을 먼저 모두 열어요. 연락처가 나온 페이지가 아직 0곳이에요: 목록을 다 읽은 뒤 상위 업체의 공식 페이지");
    // nine more pages to the end of 590: no call of the 40
    for (let from = 60; from < 590; from += 60) {
      t.call(read, "web_read", { url, itemsFrom: from });
      expect(t.hold(read, { url, itemsFrom: from })).toBeNull();
      t.result(read, { ok: true, summary: "", data: { url, items, itemsTotal: 590, itemsFrom: from, ...(from + 60 < 590 ? { nextItemsFrom: from + 60 } : {}) } });
    }
    expect(t.summary().calls).toBe(1);
    expect(t.note(1_000, "progress")).not.toContain("열린 목록부터");
    // its text read on from the cache (from): not a call either; a list's text with no more of it, or a page with
    // no more text, is one
    const art = "https://care.example.jp/guide";
    t.call(read, "web_read", { url: art });
    t.result(read, { ok: true, summary: "", data: { url: art, title: "26곳 확인", text: "…", nextFrom: 5000 } });
    t.call(read, "web_read", { url: art, from: 5000 });
    expect(t.hold(read, { url: art, from: 5000 })).toBeNull();
    t.result(read, { ok: true, summary: "", data: { url: art, text: "…" } });
    expect(t.summary().calls).toBe(2);
    t.call(read, "web_read", { url: art, from: 9000 });
    expect(t.summary().calls).toBe(3);
    // the other kind of read on (its items, where only its text was left open): a call
    const art2 = "https://care.example.jp/guide2";
    t.result(read, { ok: true, summary: "", data: { url: art2, title: "안내", text: "…", nextFrom: 5000 } });
    t.call(read, "web_read", { url: art2, itemsFrom: 60 });
    expect(t.summary().calls).toBe(4);
    // a page read again from its start, or read on where no list was left open, is a call
    t.call(read, "web_read", { url });
    t.call(read, "web_read", { url: "https://other.jp/list", itemsFrom: 60 });
    expect(t.summary().calls).toBe(6);
    // the budget's 40 run calls: the cached pages took none of them (the first two reads and the four reads on above
    // did, by hold)
    expect(t.hold(read, { url: art })).toBeNull();
    expect(t.hold(read, { url: art, from: 9000 })).toBeNull();
    expect(t.hold(read, { url: art2, itemsFrom: 60 })).toBeNull();
    expect(t.hold(read, { url: "https://other.jp/list", itemsFrom: 60 })).toBeNull();
    for (let i = 0; i < 35; i++) expect(t.hold(read, { url: `https://x${i}.jp/` })).toBeNull();
    expect(t.hold(read, { url: "https://x99.jp/" })?.data).toMatchObject({ error: "budget_spent" });
    // not '전부': each page is a call
    const d = new ExploreTracker(undefined, 1_000, "text", { text: DENTIST });
    d.call(read, "web_read", { url });
    d.result(read, { ok: true, summary: "", data: { url, items, itemsTotal: 590, nextItemsFrom: 60 } });
    d.call(read, "web_read", { url, itemsFrom: 60 });
    expect(d.summary().calls).toBe(2);
    expect(d.note(1_000, "progress")).not.toContain("열린 목록부터");
  });

  test("전부: a step offers the search's tools (no briefing, schedules, memory, friends, messages, calls, acting or account tools); other turns all", () => {
    const def = (name: string, o: Record<string, unknown> = {}) => ({ name, ...o }) as unknown as ToolDef;
    const tools = [
      def("web_search", { explore: "search" }),
      def("web_read", { explore: "read" }),
      def("k_place_search"),
      def("k_weather"),
      def("sys_time"),
      def("sys_create_artifact"),
      def("sys_show_briefing"),
      def("sys_schedule_create"),
      def("sys_remember"),
      def("sys_friend_message"),
      def("sys_join_meet"),
      def("msg_list_chats"),
      def("msg_send", { write: true, approval: () => null }),
      def("sys_phone_call", { write: true, approval: () => null }),
      def("k_popbill_issue_invoice", { write: true, connection: "popbill", approval: () => null }),
      def("k_toss_orders", { connection: "toss" }),
      def("k_with_login", { credential: async () => null }),
    ];
    const all = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    expect(all.offer(tools).map((t) => t.name)).toEqual(["web_search", "web_read", "k_place_search", "k_weather", "sys_time"]);
    // the turn's card tool stays (a late html card is kept out by the loop; a table card comes in a step)
    const carded = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "table" } });
    expect(carded.offer(tools).map((t) => t.name)).toContain("sys_create_artifact");
    const plain = new ExploreTracker(undefined, 0, "text", { text: DENTIST });
    expect(plain.offer(tools)).toHaveLength(tools.length);
    // one called anyway (an older step's list, a guessed name): not run
    expect(all.hold(def("sys_show_briefing"), {})?.data).toMatchObject({ error: "not_in_this_turn" });
    expect(plain.hold(def("sys_show_briefing"), {})).toBeNull();
  });

  test("a like-search on a list site puts its first three results that look like directories up as round-ups (a front page, a directory's path or wording); posts (one saying '정리' too, unless it names 20 places) and comparisons of doses or of one thing against another spend their slot and leave it empty; how-tos and a Korean directory for a Japan question never; a post's '맵' makes no directory; another drug's list never is one", () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    const items = Array.from({ length: 20 }, (_, i) => ({ name: `C${i}`, key: `c${i}` }));
    t.result(read, { ok: true, summary: "", data: { url: "https://medisise.co.kr/", title: "스시자로 지도", items, itemsTotal: 66 } });
    // like aitoolog.com (2026-11-16): four of these were named as sites to see; three are posts, one is Korea's
    t.result(search, { ok: true, summary: "", data: { like: "https://medisise.co.kr/", results: [
      { title: "국내 최대 스시자로 정보 웹사이트 자로자로 | 일본 마운자로 가격 비교·성지 86곳·반입 방법", url: "https://jarojaro.com/" },
      { title: "오사카 마운자로 처방받으려면 확인할 것 | 겟에세이 | 글쓰기·에세이 정보", url: "https://getaessaya.com/2639" },
      { title: "스시자로 처방, 일본 병원에서 외국인도 받을 수 있을까? | 트렌드파파고", url: "https://trendpapago.com/news4_1/463" },
      { title: "일본 마운자로 구매/구입 및 반입방법 총정리 (2026년 11월 최신 통관 규정 반영) - 건강 라이프 연구소", url: "https://healthlifelab.com/japan-mounjaro-purchase-customs-2026/" },
      { title: "전국 마운자로 처방병원 및 약국 성지 가격 총정리", url: "https://mounjaro.busancambus.com/" },
      { title: "일본 마운자로 성지·가격 비교", url: "https://excelkospi.ai/mounjaro" },
      { title: "GLP1", url: "https://glp1.co.kr/" },
      { title: "일본 한국어 병원·외국인 진료기관 찾기 | 스시자로 SUSHIJARO", url: "https://sushijaro.com/" },
    ] } });
    expect(t.roundups().map((u) => u.site)).toEqual(["jarojaro.com", "excelkospi.ai", "glp1.co.kr", "healthlifelab.com"]);
    t.call(search, "web_search", { query: "마운자로" });
    expect(t.cardLine()).toBe("아직 안 본 정리 사이트: jarojaro.com, excelkospi.ai, glp1.co.kr."); // the how-to is no directory
    // a post (a blog's entry, a channel's message, a numbered or dated page) is no directory by its '정리' or '맵', and
    // its like slot stays empty; one naming 20 places is one by its count (bitmanx.io's Telegram copy and
    // fine.fingerplay.co.kr's entry, 2026-11-16)
    const v = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    v.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro", title: "일본 마운자로 성지·가격 비교", items, itemsTotal: 749 } });
    v.result(search, { ok: true, summary: "", data: { like: "https://excelkospi.ai/mounjaro", results: [
      { title: "일본 오사카 도쿄 후쿠오카 마운자로 성지 위치 가격 예약 정리", url: "https://fine.fingerplay.co.kr/entry/일본-오사카-도쿄-후쿠오카-마운자로-성지-위치-가격-예약-정리" },
      { title: "일본 마운자로 병원 120곳 총정리", url: "https://blog.example.kr/entry/japan-mounjaro-120" },
      { title: "HOTEL de DOCTOR 24", url: "https://www.hotel-doctor.example.com/ko/articles/hospital/findingadoctor" },
      { title: "일본 마운자로 클리닉", url: "https://dir.example.jp/clinics/12345" },
      { title: "일본 마운자로 클리닉 후기 모음", url: "https://reviews.example.jp/clinics/posts/77" },
    ] } });
    v.result(search, { ok: true, summary: "", data: { query: "스시자로", results: [
      { title: "일명 '스시자로' 가격맵 사이트 - 일본, 한국보다 3배싸다? 이 맵을 사용하기 전에 미 - 비트맨X - 텔레그램 : 비트코인 ETF | 코인 텔레그램 정보", url: "https://www.bitmanx.io/channel/154153554" },
      { title: "도쿄 마운자로 지도 | 2.5mg 가격", url: "https://map.example.kr/2026/11/tokyo" },
      { title: "일본 마운자로 병원 지도", url: "https://jp-map.example.kr/" },
      { title: "도쿄 마운자로 병원 목록 정리", url: "https://trend.example.kr/news4_1/463" },
    ] } });
    v.call(search, "web_search", { query: "마운자로" });
    expect(v.cardLine()).toBe("아직 안 본 정리 사이트: blog.example.kr, dir.example.jp, reviews.example.jp, jp-map.example.kr.");
    expect(v.roundups()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ site: "blog.example.kr", url: "https://blog.example.kr/entry/japan-mounjaro-120" }),
        expect.objectContaining({ site: "fine.fingerplay.co.kr" }), // a round-up post all the same, to read if time allows
        expect.objectContaining({ site: "bitmanx.io" }),
      ]),
    );
    // a comparison of doses ('2.5mg·5mg·7.5mg') or of one thing against another ('vs.') with no count, pick or
    // per-clinic wording is a clinic's own page: no directory, and like a post it spends its slot, which stays empty
    // (aurelia-online.jp's price page; cceyelasik.com.tw's LASIK guide took the slot two posts left, 2026-11-17). One
    // dose's prices compared is a directory's wording as before
    const w = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    w.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro", title: "일본 마운자로 성지·가격 비교", items, itemsTotal: 749 } });
    w.result(search, { ok: true, summary: "", data: { like: "https://excelkospi.ai/mounjaro", results: [
      { title: "도쿄 클리닉별 마운자로 2.5mg·5mg 가격 비교", url: "https://kind.example.jp/mounjaro" },
      { title: "일본 오사카 도쿄 후쿠오카 마운자로 성지 위치 가격 예약 정리", url: "https://post.example.kr/entry/mounjaro-osaka" },
      { title: "일본 마운자로 vs. 위고비 가격 비교", url: "https://vs.example.jp/mounjaro-wegovy" },
      { title: "일본 마운자로 가격 비교", url: "https://late.example.jp/mounjaro" },
    ] } });
    w.result(search, { ok: true, summary: "", data: { like: "https://excelkospi.ai/mounjaro", results: [
      { title: "東京でマンジャロが安いクリニック14院！2.5mg・5mg・7.5mg比較", url: "https://count.example.jp/column/tokyo" },
      { title: "일본 마운자로 2.5mg 최저가 비교", url: "https://onedose.example.jp/mounjaro" },
      { title: "일본 마운자로 온라인 진료 가격 비교｜2.5mg·5mg·7.5mg·10mg | AURELIA ONLINE", url: "https://dose.example.jp/lp-mounjaro-ko.html" },
      { title: "도쿄 마운자로 가격 비교 정리", url: "https://post.example.jp/2026/11/tokyo" },
      { title: "오사카 마운자로 가격 비교", url: "https://later.example.jp/osaka" },
    ] } });
    w.call(search, "web_search", { query: "마운자로" });
    expect(w.cardLine()).toBe("아직 안 본 정리 사이트: kind.example.jp, count.example.jp, onedose.example.jp.");
    // like a site that is no list: wording only, as before
    const u = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL });
    u.result(search, { ok: true, summary: "", data: { like: "https://clinic.example.jp/", results: [{ title: "医院", url: "https://other.example.jp/" }] } });
    expect(u.roundups()).toHaveLength(0);
    // 피부과: a 마운자로 list is not a candidate, and a 마운자로 list begun is not offered to read on
    const derm = new ExploreTracker(undefined, 0, "text", { text: "도쿄·오사카 피부과 20곳 가격순 카드로" });
    derm.result(search, { ok: true, summary: "", data: { results: [
      { title: "일본 마운자로 성지·가격 비교 430곳", url: "https://excelkospi.ai/" },
      { title: "東京 皮膚科 料金 比較", url: "https://hifu-navi.jp/compare" },
    ] } });
    expect(derm.roundups().map((r) => r.site)).toEqual(["hifu-navi.jp"]);
    derm.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/", title: "일본 마운자로 성지·가격 비교", items, itemsTotal: 300, nextItemsFrom: 20 } });
    derm.result(read, { ok: true, summary: "", data: { url: "https://hifu-navi.jp/compare", title: "東京 皮膚科 料金 比較", items, itemsTotal: 45, nextItemsFrom: 20 } });
    const p = derm.note(0, "progress");
    expect(p).toContain("https://hifu-navi.jp/compare (itemsFrom=20)");
    expect(p).not.toContain("https://excelkospi.ai/ (itemsFrom");
    expect(p).toContain("그 사이트의 목록은 이어 읽지 말고");
  });

  test("the card: '20곳' holds the 20 (not a side count), '전부' what the answer said; the card is one of the calls", () => {
    const html = { name: "sys_create_artifact", kind: "html" as const };
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const derm = new ExploreTracker(undefined, 0, "text", { text: "도쿄·오사카 피부과 20곳 가격순 카드로", card: html });
    expect(derm.cardTarget()).toBe(20);
    expect(derm.takeLateCard("20곳을 모았어요. (찾아본 곳: 병원 목록 399곳)")).toBe(true);
    expect(derm.cardTarget()).toBe(20);
    const few = new ExploreTracker(undefined, 0, "text", { text: "도쿄·오사카 피부과 20곳 가격순 카드로", card: html });
    few.takeLateCard("12곳을 찾았어요");
    expect(few.cardTarget()).toBe(12);
    const all = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: html });
    const items = Array.from({ length: 60 }, (_, i) => ({ name: `C${i}`, key: `c${i}` }));
    all.result(read, { ok: true, summary: "", data: { url: "https://medisise.co.kr/", items, itemsTotal: 60 } });
    all.takeLateCard("일본 전국 90곳");
    expect(all.cardTarget()).toBe(90);
    // 12 calls with the card: the search stops at 11 while the card may still come
    const dent = new ExploreTracker(undefined, 0, "text", { text: DENTIST, card: html });
    for (let i = 0; i < 11; i++) dent.call(read, "web_read", { url: `https://d${i}.jp` });
    expect(dent.spent(1)).toBe(true);
    const bare = new ExploreTracker(undefined, 0, "text", { text: DENTIST });
    for (let i = 0; i < 11; i++) bare.call(read, "web_read", { url: `https://d${i}.jp` });
    expect(bare.spent(1)).toBe(false);
    expect(bare.note(0, "final")).toContain("끝에 되묻지 않아요");
  });

  test("the card goes out cleaned: rows naming no place dropped, example links unwrapped, {{곳수}} counted", () => {
    const html =
      `<h1>목록</h1><ul><li><a href="https://a.jp/">A</a> · 도쿄</li><li><a href="https://riss-search.example.ac.jp">(제외)</a></li>` +
      `<li><a href="https://foo.example.com/x">B 클리닉</a> · 오사카</li><li> - </li><li><a href="https://exa.ai/search?q=x">C</a></li>` +
      `<li>D<ul><li>한국어</li></ul></li></ul><p>{{곳수}}곳 · 전체 9곳 중 {{ 곳수 }}곳</p>`;
    const out = cleanCard(html);
    expect(out).not.toContain("example");
    expect(out).not.toContain("(제외)");
    expect(out).not.toContain("exa.ai");
    expect(out).toContain("<li>B 클리닉 · 오사카</li>"); // the words stay, the link goes
    expect(out).toContain("<li>한국어</li>"); // a badge inside a row is no row and no junk
    expect(cardRows(out)).toBe(4);
    expect(out).toContain("<p>4곳 · 전체 9곳 중 4곳</p>");
    expect(cardRows("<table><tr><th>이름</th></tr><tr><td>A</td></tr><tr><td>B</td></tr></table>")).toBe(2);
    // the .d row shape: one row per link inside the block; a row naming no place goes
    const d = `<div class="d"><a href="https://a.jp/"><b>A</b><em>¥1</em><small>도쿄</small></a><a href="https://b.jp/"><b>(제외)</b></a><a href="https://c.jp/"><b>C</b><small><div>2층</div></small></a><p style="order:-1">{{곳수}}곳</p></div><a href="https://src.jp/">출처</a>`;
    expect(cleanCard(d)).toContain('<p style="order:-1">2곳</p>');
    expect(cleanCard(d)).not.toContain("(제외)");
    expect(cleanCard("<table><tr><th>이름</th></tr><tr><td>A</td></tr><tr><td>(제외)</td></tr></table>")).toBe("<table><tr><th>이름</th></tr><tr><td>A</td></tr></table>");
    // shape(): only the card tool, only html, the same object when nothing changes
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    const art = { name: "sys_create_artifact" } as unknown as ToolDef;
    const args = { kind: "html", content: html };
    expect(t.shape(art, args).content).toBe(out);
    const same = { kind: "html", content: "<ul><li>A</li></ul>" };
    expect(t.shape(art, same)).toBe(same);
    expect(t.shape(read, args)).toBe(args);
    expect(new ExploreTracker(undefined, 0, "voice", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } }).shape(art, args)).toBe(args);
  });

  test("card rows: parsed and checked one by one, drawn with counts from the rows; a page cut short is asked again; 12 calls hold the card", () => {
    expect(priceValue("2.5mg 4주 ¥9,800~")).toEqual({ v: 9800, cur: "yen" });
    expect(priceValue("1회 187,000원")).toEqual({ v: 187000, cur: "won" });
    expect(priceValue("1.5만 원")).toEqual({ v: 15000, cur: "won" });
    expect(priceValue("확인 안 됨")).toBeNull();
    expect(cardRowOf(["도쿄", "  A  클리닉 ", "신주쿠", "¥9,800", "02-0000-0000 (임시번호)", "http://a.jp/", "공식 페이지"])).toEqual({
      group: "도쿄", name: "A 클리닉", area: "신주쿠", price: "¥9,800", contact: "확인 안 됨", url: "", check: "공식 페이지",
    }); // http and a placeholder phone are out
    expect(cardRowOf({ region: "오사카", name: "B", link: "https://b.jp/x" })!.url).toBe("https://b.jp/x");
    expect(cardRowOf(["도쿄", "(제외)"])).toBeNull();
    for (const page of ["경기일보 기사", "MBC imnews 뉴스", "스시자로 JP 안내 페이지", "마운자로 후기 블로그"]) expect(cardRowOf(["온라인", page, "", "", "", "https://news.jp/a", "검색 요약"])).toBeNull();
    expect(cardRowOf(["도쿄", "블루보틀 카페", "기요스미", "", "", "https://bb.jp/", "공식 페이지"])!.name).toBe("블루보틀 카페"); // a café is a place
    expect(cardRowOf("A")).toBeNull();
    expect(cardRowOf(["도쿄", "A", "", "", "", "https://例え.jp/パス", ""])!.url).toBe("https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9"); // ASCII as stored
    // links whole (a clipped one is broken), as long as the app opens them (2,048 once encoded); longer: no link, the row stays
    const longAscii = `https://a.jp/${"p".repeat(1500)}`;
    expect(cardRowOf(["도쿄", "A", "", "", "", longAscii, ""])!.url).toBe(longAscii);
    const hangulOk = `https://a.jp/${"가".repeat(220)}`; // 13 + 220 × 9 = 1,993
    expect(cardRowOf(["도쿄", "A", "", "", "", hangulOk, ""])!.url).toBe(new URL(hangulOk).href);
    expect(new URL(hangulOk).href.length).toBeLessThanOrEqual(CARD_URL_MAX);
    const hangulLong = cardRowOf(["도쿄", "B", "", "", "", `https://a.jp/${"가".repeat(300)}`, ""])!; // 300 letters, 2,713 encoded
    expect(hangulLong.url).toBe("");
    expect(cardRowOf(["도쿄", "C", "", "", "", `https://a.jp/${"p".repeat(2100)}`, ""])!.url).toBe("");
    const noLink = renderRowsCard({ title: "목록", basis: "", rows: [hangulLong], regulated: false });
    expect(noLink).toContain("<li><div><div class=\"t\"><b>B</b>");
    expect(noLink).not.toContain("%E2%80%A6");
    const rows = [cardRowOf(["온라인", "<b>X</b>", "", "¥3,000", "LINE", "https://x.jp/?a=1&b=2", ""])!];
    const html = renderRowsCard({ title: "목록", basis: "", rows, regulated: false });
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(html).toContain('<li><a href="https://x.jp/?a=1&amp;b=2"><div class="t"><b>&lt;b&gt;X&lt;/b&gt;</b><small>LINE</small></div><span class="p"><b>¥3,000</b></span></a></li>'); // the whole row one link, the price apart
    expect(html).not.toContain("반입 기준");
    // what every row shares is said once on top; a neutral pill opens the meta line only where a row's check differs;
    // area · contact on one line; unknown fields stay out of the row; the summary first
    const r4 = (check: string, i: number, contact = "", price = "") => cardRowOf(["도쿄", `곳 ${i}`, "신주쿠역", price, contact, `https://p${i}.jp/`, check])!;
    const mixed = renderRowsCard({ title: "목록", basis: "11/15 확인", rows: [r4("정리 사이트", 1, "", "2.5mg 4주 ¥9,800~¥12,000"), r4("정리 사이트", 2, "확인 안 됨", "미확인"), r4("공식 페이지", 3, "03-3770-3381"), r4("정리 사이트", 4)], regulated: false });
    expect(mixed).toContain(`<p>${items("확인: 대부분 정리 사이트", "다른 곳만 표시")}</p>`);
    expect(mixed.match(/class="bd"/g) ?? []).toHaveLength(1);
    expect(mixed).toContain(`<b>곳 3</b><small><span class="bd">공식 페이지</span>신주쿠역${DOT} 03-3770-3381</small>`);
    expect(mixed).toContain('<b>곳 2</b><small>신주쿠역</small></div></a>'); // no '확인 안 됨', no '미확인' price
    expect(mixed).toContain('<span class="p"><b>¥9,800~<wbr>¥12,000</b><small>2.5mg 4주</small></span>'); // fits its column: nothing to hold
    // a detail's last word of two characters never takes a line alone ('… 웹 / 예약' ended on '예약', 2026-11-17)
    // (held when the line may wrap on the narrowest card; a tail too wide for a short line is left to wrap)
    const rowAt = (i: number, area: string, contact: string) => cardRowOf(["도쿄", `곳 ${i}`, area, "", contact, `https://p${i}.jp/`, "정리 사이트"])!;
    const tied = renderRowsCard({ title: "목록", basis: "", rows: [rowAt(1, "카타파하 가나다라마바사아자", "웹 / 예약"), rowAt(2, "카타파하 가나다라마바사아자", "전화 문의처"), rowAt(3, "가나다라마바사아자차카타파하가나다라", "웹"), r4("정리 사이트", 4, "웹 / 예약")], regulated: false });
    expect(tied).toContain(`<b>곳 1</b><small>카타파하 가나다라마바사아자${DOT} <span class="n">웹 / 예약</span></small>`);
    expect(tied).toContain(`<b>곳 2</b><small>카타파하 가나다라마바사아자${DOT} 전화 문의처</small>`);
    expect(tied).toContain(`<b>곳 3</b><small>가나다라마바사아자차카타파하가나다라${DOT} 웹</small>`);
    expect(tied).toContain(`<b>곳 4</b><small>신주쿠역${DOT} 웹 / 예약</small>`); // one short line: nothing to hold
    expect(tied).toContain(".n{white-space:nowrap;display:inline-block}"); // WebKit set a nowrap tail 2 px past its line
    expect(mixed).not.toContain("미확인");
    expect(mixed).not.toContain("확인 안 됨");
    expect(mixed).toContain(`<p>${items("연락 수단 적힌 곳 1곳", "가격 적힌 곳 1곳")}</p>`);
    expect(mixed.indexOf('class="sum"')).toBeLessThan(mixed.indexOf("<h3>"));
    expect(mixed).toContain(".p{flex:0 1 auto;min-width:0;max-width:38%");
    const same = renderRowsCard({ title: "목록", basis: "", rows: [r4("정리 사이트", 1), r4("정리 사이트", 2)], regulated: false });
    expect(same).toContain(`<p>${nw("확인: 모두 정리 사이트")}</p>`);
    expect(same).not.toContain('class="bd"');
    expect(same).not.toContain('class="p"'); // no prices at all: no price column, the summary says so
    expect(same).toContain(`<p>${items("연락 수단은 각 링크에서 확인해요", "가격 확인 안 됨")}</p>`);
    // a price without an amount is no price: none has one, so no priced count and no order by price; the row still says it
    const asked = renderRowsCard({ title: "목록", basis: "11/15 확인", rows: [r4("정리 사이트", 1, "", "상담 후 결정"), r4("정리 사이트", 2, "", "가격 문의")], regulated: false });
    expect(asked).toContain(`<p>${items("연락 수단은 각 링크에서 확인해요", "가격 확인 안 됨")}</p>`);
    expect(asked).toContain(`<p class="meta">${nw("11/15 확인")}</p>`);
    // the basis (the model's words): its dots stay at the end of a line, a date stays whole; the same for the meta's own dot
    const dated = renderRowsCard({ title: "목록", basis: "정리 사이트 3곳 · 2026-11-15 확인", rows: [r4("정리 사이트", 1, "", "¥3,000")], regulated: false });
    expect(dated).toContain(`<p class="meta">${items("정리 사이트 3곳", "2026-11-15 확인", "지역별로 묶고 가격 낮은 순")}</p>`);
    // a basis item longer than a line: its last word holds the dot (WebKit's text-wrap:pretty broke before a lone
    // nbsp: '…1개)' / ' · 2026-11-15'), a date in the part that wraps stays whole
    const wide = renderRowsCard({ title: "목록", basis: "정리 사이트 세 곳과 공식 페이지 열두 곳 2026-11-15 확인 (마운자로 2.5mg 4개 1개) · 합성", rows: [r4("정리 사이트", 1, "", "¥3,000")], regulated: false });
    expect(wide).toContain(`<p class="meta">정리 사이트 세 곳과 공식 페이지 열두 곳 ${nw("2026-11-15")} 확인 ${nw("(마운자로")} 2.5mg 4개 ${nw(`1개)${DOT}`)} ${items("합성", "지역별로 묶고 가격 낮은 순")}</p>`);
    // the date with what touches it (no space between): a nowrap span is an inline-block, a break place on both sides
    // ('2026-11-11 / ~16', '2026-11-15 / 에', '( / 2026-11-15'; design-director, 2026-11-17)
    const basisOf = (basis: string) => /<p class="meta">(.*?)<\/p>/.exec(renderRowsCard({ title: "목록", basis, rows: [r4("정리 사이트", 1, "", "¥3,000")], regulated: false }))![1]!;
    expect(basisOf("나머지는 마운자로 정리 사이트 열두 곳을 2026-11-12~16 정리 사이트 기준")).toContain(`을 ${nw("2026-11-12~16")} 정리`);
    expect(basisOf("각 클리닉 누리집과 정리 사이트 열두 곳에서 2026-11-15에 확인한 가격 기준")).toContain(` ${nw("2026-11-15에")} 확인한`);
    expect(basisOf("각 클리닉 누리집과 정리 사이트 열두 곳의 가격 (2026-11-15 기준) 합성 목록")).toContain(` ${nw("(2026-11-15")} 기준)`);
    expect(basisOf("각 클리닉 누리집과 정리 사이트 열두 곳의 가격 [2026-11-11~2026-11-16] 합성 목록")).toContain(` ${nw("[2026-11-11~2026-11-16]")} 합성`);
    // a chunk wider than the narrowest line holds its date alone, the rest may wrap
    const chunk = `${"가".repeat(14)}2026-11-15${"나".repeat(14)}`;
    expect(basisOf(`각 클리닉 누리집과 정리 사이트 ${chunk} 확인`)).toContain(`${"가".repeat(14)}${nw("2026-11-15")}${"나".repeat(14)}`);
    // a word with a bracket, a middle dot or a comma in it, likewise: WebKit broke after '(' ('기준( / 엔'), Chrome before
    // '·' ('페이지 / ·비교'), WebKit before ',' after ')' ('표기) / , 2026'); design-director, 2026-11-17
    expect(basisOf("첫 진료 상담료·기본 시술료 기준(엔, 세금 포함 표기), 2026-11-15 확인 · 전화는 국가번호 +81")).toContain(`첫 진료 ${nw("상담료·기본")} 시술료 ${nw("기준(엔,")} 세금 포함 ${nw("표기),")} ${nw("2026-11-15")} ${nw(`확인${DOT}`)}`);
    expect(basisOf("소아청소년과 의원 주소·전화 (진료비 아님) · 2026-11-17 확인")).toContain(`소아청소년과 의원 ${nw("주소·전화")} ${nw("(진료비")} ${nw(`아님)${DOT}`)}`);
    expect(basisOf("정리 사이트 열두 곳의 도쿄,오사카 공개 가격과 연락처 확인")).toContain(`곳의 ${nw("도쿄,오사카")} 공개`);
    // a word with a quote or a bracket inside it, as Text.tsx ties them: both engines break after ” ’ before Hangul,
    // WebKit after “ ‘ too (snap-fnd-quote)
    expect(basisOf("각 클리닉 누리집 공개 가격 표기)에서 세금 포함 값을 골라 2026-11-15 확인")).toContain(`공개 가격 ${nw("표기)에서")} 세금`);
    expect(basisOf("정리 사이트 열두 곳의 “공식가”로 적힌 값과 ‘후기 가격’은 빼고 2026-11-15 확인")).toContain(`곳의 ${nw("“공식가”로")} 적힌 값과 ${nw("‘후기")} ${nw("가격’은")} 빼고`);
    expect(basisOf("「マンジャロ」の公開価格 기준으로 『정리 사이트』에서 모은 값 2026-11-15 확인")).toContain(`${nw("「マンジャロ」の公開価格")} 기준으로 ${nw("『정리")} ${nw("사이트』에서")} 모은`);
    // a word's last comma breaks nowhere: no tie ('가격,' beside the date's tie cost WebKit a line at 267)
    expect(basisOf("2.5mg 4주(4펜) 공개 가격, 2026-11-15 엑셀코스피 병원 공식 홈페이지 확인")).toContain(`2.5mg ${nw("4주(4펜)")} 공개 가격, ${nw("2026-11-15")} 엑셀코스피`);
    // a lone mark is no word; a chunk wider than the narrowest line stays as it is
    const dots = `${"가".repeat(12)}·${"나".repeat(12)}`;
    expect(basisOf(`각 클리닉 누리집과 정리 사이트 ${dots} , 공식 페이지 확인`)).toContain(`사이트 ${dots} , 공식 페이지 ${nw(`확인${DOT}`)}`);
    // its height is the text's (the span's tags take no room): as tall as the same words with slashes, whatever the length
    const tallOf = (basis: string) => drawRowsCard({ title: "목록", basis, rows: [r4("정리 사이트", 1, "", "¥3,000")], regulated: false }).px;
    for (let n = 1; n <= 12; n++) {
      const words = Array.from({ length: n }, (_, i) => `정리${i}`).join(" ");
      expect(tallOf(`${words} 2026-11-15 확인 · 합성`)).toBe(tallOf(`${words} 2026/11/15 확인 · 합성`));
    }
    expect(asked).toContain('<span class="p"><small>상담 후 결정</small></span>');
    // one price unit: the most common one gives the min and max (named) and goes first by price; other units after, then none
    const u = (name: string, price: string, group = "도쿄") => cardRowOf([group, name, "", price, "", `https://${encodeURIComponent(name)}.jp/`, "정리 사이트"])!;
    const units = renderRowsCard({ title: "목록", basis: "", rows: [u("A", "5mg 4本 ¥20,000"), u("B", "2.5mg 4本 ¥9,800"), u("C", "2.5mg 4펜 ¥7,400"), u("D", ""), u("E", "1개월 ¥1,000"), u("F", "2.5mg 4本 ¥3,000", "온라인")], regulated: true });
    expect(units).toContain(`<p>${items("2.5mg 4개 기준 최저 ¥3,000", "최고 ¥9,800")}</p>`); // not ¥1,000 (a month) nor ¥20,000 (5mg)
    const at = (n: string) => units.indexOf(`<b>${n}</b>`);
    expect([at("C"), at("B"), at("E"), at("A"), at("D")]).toEqual([...[at("C"), at("B"), at("E"), at("A"), at("D")]].sort((x, y) => x - y));
    // 0 is no price: never the lowest, not counted priced
    const zero = renderRowsCard({ title: "목록", basis: "", rows: [u("A", "2.5mg 4本 ¥9,800"), u("B", "2.5mg 4本 ¥0"), u("C", "0円")], regulated: true });
    expect(zero).toContain(`<p>${items("2.5mg 4개 기준 최저 ¥9,800", "최고 ¥9,800")}</p>`);
    expect(zero).toContain("가격 적힌 곳 1곳");
    expect(units).toContain("<small>2.5mg 4개</small>"); // '4本' said in Korean
    // other units after a small line (design-director); a group with one unit has none
    expect(units.split('<p class="sep">다른 기준 가격</p>')).toHaveLength(2);
    expect(at("B")).toBeLessThan(units.indexOf('class="sep"'));
    expect(units.indexOf('class="sep"')).toBeLessThan(at("E"));
    expect(cardRows(units)).toBe(6); // the line is no row
    expect(cardRowOf(["도쿄", "곳", "", "", "", "", "검색 요약"])!.check).toBe("검색 결과만");
    expect(units.indexOf("<h3>도쿄")).toBeLessThan(units.indexOf("<h3>온라인")); // groups as they came
    expect(units).toContain("반입 기준");
    // a long unit name is clipped near 20 characters (design-director); the amounts stay whole
    const wordy = renderRowsCard({ title: "목록", basis: "", rows: [u("A", "2.5mg 4本 첫 달 한정 진료비 포함 ¥9,800"), u("B", "2.5mg 4本 첫 달 한정 진료비 포함 ¥8,800")], regulated: false });
    // too long for one line with its amount: the name may wrap, the amount stays whole
    expect(wordy).toContain(`<p>2.5mg 4개 첫 달 한정 진료비… 기준 ${items("최저 ¥8,800", "최고 ¥9,800")}</p>`);
    // a unit with its own dot: its parts are items too, the dot held by the part before; in the row a nbsp holds it
    const dotted = renderRowsCard({ title: "목록", basis: "", rows: [u("A", "2.5mg 4本 · 첫 달 ¥9,800"), u("B", "2.5mg 4本 · 첫 달 ¥8,800")], regulated: false });
    expect(dotted).toContain(`<p>${items("2.5mg 4개", "첫 달 기준 최저 ¥8,800", "최고 ¥9,800")}</p>`);
    expect(dotted).toContain(`<small>2.5mg 4개${DOT} <span class="n">첫 달</span></small>`); // past the price column: held
    // whole only if it fits the narrowest card's line, 244 px less the box's 28 (this one fits 228, not 216)
    const near = renderRowsCard({ title: "목록", basis: "", rows: [u("A", "2.5mg 가나다라 ¥9,800"), u("B", "2.5mg 가나다라 ¥8,800")], regulated: false });
    expect(near).toContain(`<p>2.5mg 가나다라 기준 ${items("최저 ¥8,800", "최고 ¥9,800")}</p>`);
    // one card holds them all, sized in UTF-8 bytes under the agent-card cap (300 KB, a few KB spare)
    const ascii = Array.from({ length: 500 }, (_, i) => cardRowOf([i % 3 ? "Tokyo" : "Online", `Clinic ${i}`, "Shinjuku 3 min", "2.5mg 4 weeks ¥9,800", "LINE", `https://c${i}.clinic.jp/`, "list site"])!);
    const all = renderRowsCard({ title: "List", basis: "", rows: ascii, regulated: false });
    expect((all.match(/<li>/g) ?? []).length).toBe(500);
    expect(all).toContain(`<p>${nw("<b>500곳</b>")}</p>`);
    expect(bytes(all)).toBeLessThan(CARD_AGENT_BYTES);
    const hangul = Array.from({ length: 500 }, (_, i) => cardRowOf(["도쿄", `${"아주 긴 클리닉 이름 ".repeat(3)}${i}`, "신주쿠역 동쪽 출구 도보 3분", "2.5mg 4주 첫 달 ¥9,800", "카카오톡 상담 · 전화 예약", `https://c${i}.clinic.jp/${"경로".repeat(10)}`, "정리 사이트"])!);
    const long = renderRowsCard({ title: "목록", basis: "", rows: hangul, regulated: true });
    const longN = (long.match(/<li>/g) ?? []).length;
    expect(bytes(long)).toBeLessThanOrEqual(CARD_AGENT_BYTES - 4096);
    expect(long).toContain(`<p>${nw("<b>500곳</b>")}</p>`);
    expect(longN).toBe(500);
    // every field at its longest (~1 KB a row): the short form, then each region's tail goes (no price first, then the
    // dearest) and every region stays; the summary counts all 500
    const field = (i: number) => {
      const group = ["도쿄", "오사카", "온라인"][i % 3]!;
      return cardRowOf([group, `${i} ${"아주긴클리닉이름".repeat(8)}`, "가".repeat(40), i % 5 === 0 ? "" : `${"가격설명".repeat(8)} ¥${10_000 + i * 10}`, "카톡 ".repeat(20), `https://clinic${i}.clinic.jp/${"p".repeat(380)}`, i % 7 ? "정리 사이트" : "공식 페이지"])!;
    };
    const huge = Array.from({ length: 500 }, (_, i) => field(i));
    const cut = renderRowsCard({ title: "목록", basis: "", rows: huge, regulated: false });
    expect(bytes(cut)).toBeLessThanOrEqual(CARD_AGENT_BYTES - 4096);
    const shownN = (cut.match(/<li>/g) ?? []).length;
    expect(shownN).toBeLessThan(500);
    expect(shownN).toBeGreaterThan(150);
    expect(cut).toContain(`<p>${nw(`<b>전체 500곳 중 ${shownN}곳</b>${DOT}`)} 카드 크기 한도로 지역마다 가격 없는 곳·비싼 곳부터 뺐어요</p>`);
    expect(cut).toContain(nw(`가격 적힌 곳 ${huge.filter((r) => r.price).length}곳`)); // all rows, not the shown ones
    expect(cut).not.toContain("카톡 카톡"); // the short form: no contact
    for (const g of ["도쿄", "오사카", "온라인"]) expect(cut).toContain(`<h3>${g}<span>`);
    const kept = huge.filter((r) => cut.includes(`<b>${r.name}</b>`));
    expect(kept).toHaveLength(shownN);
    expect(kept.some((r) => !r.price)).toBe(false); // no-price rows went first
    for (const g of ["도쿄", "오사카", "온라인"]) {
      const mine = huge.filter((r) => r.group === g && r.price);
      const keptMax = Math.max(...kept.filter((r) => r.group === g).map((r) => priceValue(r.price)!.v));
      const goneMin = Math.min(...mine.filter((r) => !kept.includes(r)).map((r) => priceValue(r.price)!.v));
      expect(keptMax).toBeLessThan(goneMin); // each region keeps its cheapest
    }
    // the html tool's size (a store without the agent-card size): the same rules at 150 KB
    const small = renderRowsCard({ title: "목록", basis: "", rows: huge, regulated: false, maxBytes: 150 * 1024 });
    expect(bytes(small)).toBeLessThanOrEqual(146 * 1024);
    // a page cut at max_tokens: the next card step asks for fewer rows, once more
    const t = new ExploreTracker(undefined, Date.now(), "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    const real = { name: "sys_create_artifact", run: async () => ({ ok: true, summary: "" }) } as unknown as ToolDef;
    expect(t.rowsTool(real)!.name).toBe("card_rows");
    expect(t.cardStepTool()).toBe("card_rows");
    t.call(undefined, "card_rows", undefined);
    t.call(real, "card_rows", {});
    expect(t.rowsPending()).toBe(false);
    t.cardWasCut();
    expect(t.rowsPending()).toBe(true);
    expect(t.note(0, "card")).toContain("50행 이하로 보내고");
    // no rows tool for a table card, a voice call or a plain find
    expect(new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "table" } }).rowsTool(real)).toBeNull();
    expect(new ExploreTracker(undefined, 0, "text", { text: DENTIST, card: { name: "sys_create_artifact", kind: "html" } }).rowsTool(real)).toBeNull();
    // 12 calls with the card: an 11th search runs, a 12th parallel one does not (the card keeps it)
    const d = new ExploreTracker(undefined, 0, "text", { text: DENTIST, card: { name: "sys_create_artifact", kind: "html" } });
    for (let i = 0; i < 11; i++) expect(d.hold(read, { url: `https://d${i}.jp` })).toBeNull();
    expect(d.hold(read, { url: "https://d11.jp" })!.summary).toBe("찾기 예산을 다 써서 부르지 않았어요");
    expect(d.hold({ name: "sys_create_artifact" } as unknown as ToolDef, { kind: "html", content: "<ul><li>A</li></ul>" })).toBeNull();
  });

  test("a row's name goes through the app's glued() (glue.ts): no line ending on '(' or cut inside a number in WebKit; the card's sheet holds the two classes (the app's CSS does not reach the frame); each piece escaped on its own; the rest of the row as before (design-director, deep-37)", () => {
    const names = ["현대주차장(민영)", "A&B 클리닉(東京)", "<b>X</b>(3)", "Tom's(2.5mg)", "(&B) 의원", "가족(👨‍👩‍👧) 치과", "클리닉 000"];
    const rows = names.map((n, i) => cardRowOf(["도쿄", n, "신주쿠역 (동쪽)", `${1000 + i}엔`, "03-3770-3381", `https://g${i}.jp/`, ""])!);
    const html = renderRowsCard({ title: "목록", basis: "", rows, regulated: false });
    expect(html).toContain(".t-glue{white-space:pre}.t-brk{display:inline-block}</style>");
    expect(html).toContain('<b>현대주차장<span class="t-brk"></span><span class="t-glue">(민영)</span></b>');
    expect(html).toContain('<b>A&amp;B 클리닉<span class="t-brk"></span><span class="t-glue">(東京)</span></b>');
    expect(html).toContain('<b>&lt;b&gt;X&lt;/b&gt;<span class="t-brk"></span><span class="t-glue">(3)</span></b>');
    expect(html).toContain('<b><span class="t-glue">(&amp;B)</span> 의원</b>');
    expect(html).toContain("<b>클리닉 000</b>"); // nothing to glue
    // the names as written; every text run between tags escaped whole (no tag inside an entity)
    expect(namesOn(html).sort()).toEqual([...names].sort());
    for (const b of html.match(/<div class="t"><b>.*?<\/b>/g)!)
      for (const run of b.slice('<div class="t"><b>'.length, -"</b>".length).split(/<span class="t-glue">|<\/span>|<span class="t-brk">/)) expect([b, /^(?:[^&<>"']|&(?:amp|lt|gt|quot|#39);)*$/.test(run)]).toEqual([b, true]);
    // the detail line and the price are drawn as before (glued names only)
    expect(html).toContain("<small>신주쿠역 (동쪽) · 03-3770-3381</small>");
    expect(html.match(/class="t-glue"/g)!.length).toBe(html.match(/<div class="t"><b>[^]*?<\/b>/g)!.join("").match(/class="t-glue"/g)!.length);
  });

  test("the summary's min and max leave out an amount under a quarter or over ten times its unit's median, the row staying in the list and the line saying how many; under 4 rows in the unit all count", () => {
    const u = (name: string, price: string, group = "도쿄") => cardRowOf([group, name, "", price, "", `https://${encodeURIComponent(name)}.jp/`, "정리 사이트"])!;
    const card = (rows: ReturnType<typeof u>[]) => renderRowsCard({ title: "목록", basis: "", rows, regulated: false });
    // the price line: none left out, nothing after the highest; some, an item says how many (its end kept whole)
    const range = (lo: string, hi: string, far = 0) =>
      `<p>${far ? `${items(`2.5mg 4개 기준 최저 ${lo}`, `최고 ${hi}${DOT}`)} ${nw(`크게 다른 값 ${far}곳은`)} ${nw("최저·최고에서 뺐어요")}` : items(`2.5mg 4개 기준 최저 ${lo}`, `최고 ${hi}`)}</p>`;
    // a visit fee and a three-month total among four-pen prices (median ¥10,000, between 9,800 and 10,200)
    const fees = [u("진찰료", "2.5mg 4本 500円"), u("A", "2.5mg 4本 ¥9,800"), u("B", "2.5mg 4本 ¥10,200"), u("C", "2.5mg 4本 ¥8,000", "오사카"), u("D", "2.5mg 4本 ¥12,000", "오사카"), u("석 달", "2.5mg 4本 ¥132,000")];
    const far = card(fees);
    expect(far).toContain(range("¥8,000", "¥12,000", 2));
    for (const name of ["진찰료", "석 달"]) expect(far).toContain(`<b>${name}</b>`); // in the list still, by price
    expect(far.indexOf("<b>진찰료</b>")).toBeLessThan(far.indexOf("<b>A</b>"));
    expect(cardRows(far)).toBe(6);
    expect(far).toContain("가격 적힌 곳 6곳");
    // a quarter and ten times the median count; a yen past either does not (a dear real price stays the highest)
    expect(card(["¥2,500", "¥10,000", "¥10,000", "¥100,000"].map((p, i) => u(`E${i}`, `2.5mg 4本 ${p}`)))).toContain(range("¥2,500", "¥100,000"));
    expect(card(["¥2,499", "¥10,000", "¥10,000", "¥100,001"].map((p, i) => u(`F${i}`, `2.5mg 4本 ${p}`)))).toContain(range("¥10,000", "¥10,000", 2));
    expect(card(["¥2,499", "¥10,000", "¥10,000", "¥66,000"].map((p, i) => u(`J${i}`, `2.5mg 4本 ${p}`)))).toContain(range("¥10,000", "¥66,000", 1));
    // an even count's median is the mean of its two middle amounts (¥10,000, between 9,000 and 11,000)
    expect(card(["¥2,400", "¥9,000", "¥11,000", "¥105,000"].map((p, i) => u(`K${i}`, `2.5mg 4本 ${p}`)))).toContain(range("¥9,000", "¥11,000", 2));
    // an odd count's median is its middle amount (¥9,000)
    expect(card(["¥2,200", "¥8,000", "¥9,000", "¥10,000", "¥95,000"].map((p, i) => u(`G${i}`, `2.5mg 4本 ${p}`)))).toContain(range("¥8,000", "¥10,000", 2));
    // the median of every region's rows in amount order (¥9,000): Osaka's ¥2,600 is within a quarter of it
    const regions = [...["¥9,000", "¥10,000", "¥11,000"].map((p, i) => u(`T${i}`, `2.5mg 4本 ${p}`)), ...["¥2,600", "¥2,700"].map((p, i) => u(`O${i}`, `2.5mg 4本 ${p}`, "오사카"))];
    expect(card(regions)).toContain(range("¥2,600", "¥11,000"));
    // under 4 rows the median is no guide: the fee is the lowest as before, no item; at 4 it is not
    expect(card(fees.slice(0, 3))).toContain(range("500円", "¥10,200"));
    expect(card([...fees.slice(0, 3), fees[5]!])).toContain(range("¥9,800", "¥10,200", 2));
    // the unit's own median: other units' amounts neither move it nor count (three ¥30,000 quarters would make it ¥10,000)
    const months = ["¥2,300", "¥8,000", "¥9,000", "¥10,000"].map((p, i) => u(`H${i}`, `2.5mg 4本 ${p}`));
    expect(card([...months, ...[0, 1, 2].map((i) => u(`M${i}`, "3개월 ¥30,000"))])).toContain(range("¥2,300", "¥10,000"));
  });

  test("rows over one card's caps ('전부') go on as many cards as they take: each under both caps, every row once, the regions in their order on each, each region's cheapest first; titles and summaries numbered", () => {
    const G = ["도쿄", "오사카", "온라인", "후쿠오카", "나고야", "교토", "삿포로"];
    const fill = (n: number, off: number) => Array.from({ length: n }, (_, i) => "가나다라마바사아자차카타파하"[(i + off) % 14]).join("");
    // a tenth with no amount; prices not in row order
    const row = (i: number) => cardRowOf([G[i % G.length]!, `${String(i + 1).padStart(4, "0")} ${fill(30, i)}`, fill(20, i + 3), i % 10 === 9 ? "상담 후 결정" : `2.5mg 4개 ¥${(9_000 + ((i * 37) % 1300) * 10).toLocaleString()}`, `웹 예약 ${fill(20, i)}`, `https://c${i}.jp/`, "정리 사이트"])!;
    const rows = Array.from({ length: 1300 }, (_, i) => row(i));
    const { cards, left } = drawRowsCards({ title: "목록", basis: "합성", rows, regulated: true });
    expect(left).toEqual([]);
    expect(cards.length).toBeGreaterThanOrEqual(3);
    const heads = (h: string) => [...h.matchAll(/<h3>([^<]*)<span>/g)].map((m) => m[1]!);
    cards.forEach(({ title, card }, i) => {
      expect(title).toBe(`목록 (${i + 1}/${cards.length})`);
      expect(card.left).toEqual([]);
      expect(card.bytes).toBeLessThanOrEqual(CARD_AGENT_BYTES - 4096);
      expect(card.px).toBeLessThanOrEqual(CARD_HEIGHT_BUDGET);
      expect(card.html).toContain(`<h2>${title}</h2>`);
      expect(cardRows(card.html)).toBe(card.shown.length);
      expect(card.html).toContain(`<p>${nw(`<b>전체 1300곳 중 ${card.shown.length}곳</b>${DOT}`)} ${items(`카드 ${i + 1}/${cards.length}`, i ? "앞 카드에서 이어져요" : "나머지는 다음 카드에 이어져요")}</p>`);
      const hs = heads(card.html);
      expect(hs).toEqual(G.filter((g) => hs.includes(g))); // the regions in the order they came
    });
    expect(heads(cards[0]!.card.html)).toEqual(G); // every region on the first
    const shown = cards.flatMap((c) => c.card.shown);
    expect(shown).toHaveLength(1300);
    expect(new Set(shown).size).toBe(1300);
    // a region's priced places: those on a card are no dearer than those on the next; no price after all priced
    for (const g of G) {
      const on = cards.map((c) => c.card.shown.filter((r) => r.group === g));
      for (let i = 1; i < on.length; i++) {
        const yen = (xs: ReturnType<typeof drawRowsCard>["shown"]) => xs.map((r) => priceValue(r.price)?.v).filter((v): v is number => v !== undefined);
        const before = yen(on[i - 1]!);
        const after = yen(on[i]!);
        if (before.length && after.length) expect(Math.max(...before)).toBeLessThanOrEqual(Math.min(...after));
        if (on[i - 1]!.some((r) => !priceValue(r.price))) expect(after).toEqual([]);
      }
    }
    // rows one card holds: that card, as drawRowsCard draws it
    const few = rows.slice(0, 50);
    const one = drawRowsCards({ title: "목록", basis: "합성", rows: few, regulated: true });
    expect(one.cards).toHaveLength(1);
    expect(one.cards[0]!.title).toBe("목록");
    expect(one.cards[0]!.card.html).toBe(drawRowsCard({ title: "목록", basis: "합성", rows: few, regulated: true }).html);
  });

  test("rows card: both caps hold, 300 KB and 96,000 px (estimated at 256 px, a 320-pt screen); over either, the short form, then region tails; the summary counts all", () => {
    const limit = CARD_AGENT_BYTES - 4096;
    // the estimate beside the browsers: Chrome and WebKit drew these at 256 px of content (srcdoc.ts BASE, 2026-11-15);
    // it is never under, and over by what the glyph margin costs (Hangul wraps sooner: up to 17%)
    const ascii = Array.from({ length: 500 }, (_, i) => cardRowOf([i % 3 ? "Tokyo" : "Online", `Clinic ${i}`, "Shinjuku 3 min", "2.5mg 4 weeks ¥9,800", "LINE", `https://c${i}.clinic.jp/`, "list site"])!);
    const hangul = Array.from({ length: 500 }, (_, i) => cardRowOf(["도쿄", `${"아주 긴 클리닉 이름 ".repeat(3)}${i}`, "신주쿠역 동쪽 출구 도보 3분", "2.5mg 4주 첫 달 ¥9,800", "카카오톡 상담 · 전화 예약", `https://c${i}.clinic.jp/${"경로".repeat(10)}`, "정리 사이트"])!);
    for (const [rows, regulated, measured] of [[ascii, false, 32_146], [hangul, true, 72_104]] as const) {
      const c = drawRowsCard({ title: rows === ascii ? "List" : "목록", basis: "", rows, regulated });
      expect(c.shown).toHaveLength(500);
      expect(c.px).toBeGreaterThanOrEqual(measured);
      expect(c.px).toBeLessThan(measured * 1.2);
    }
    // screens-more's tall probe: names 60, areas 40, contacts 40 — 287 KB, under the byte cap, but 104,682 px drawn
    // whole at 326 px and 106,859 at 256 even without contacts: the short form, then region tails (all 500 in the
    // summary). Its 405-row cut measured 86,785 px at 256 in Chrome and WebKit
    const G = ["도쿄", "오사카", "온라인", "후쿠오카", "나고야", "교토", "삿포로", "요코하마", "고베", "센다이", "히로시마", "오키나와"];
    const fill = (n: number, off: number) => Array.from({ length: n }, (_, i) => "가나다라마바사아자차카타파하"[(i + off) % 14]).join("");
    const tallRow = (i: number, price: string, check = "정리 사이트") => {
      const r = cardRowOf([G[i % G.length], `${String(i + 1).padStart(3, "0")} ${fill(56, i)}`, fill(40, i + 3), price, `웹 예약 ${fill(34, i + 5)}`, "", check])!;
      r.url = `https://clinic-${i + 1}.example.jp/m`;
      return r;
    };
    const tall = Array.from({ length: 500 }, (_, i) => tallRow(i, `2.5mg 4개 ¥${(18_000 + i * 10).toLocaleString()}`));
    const a = drawRowsCard({ title: "긴 이름 500곳", basis: "합성", rows: tall, regulated: true });
    expect(a.short).toBe(true);
    expect(a.px).toBeLessThanOrEqual(CARD_HEIGHT_BUDGET);
    expect(a.bytes).toBeLessThanOrEqual(limit);
    expect(a.html).not.toContain("웹 예약");
    expect(a.shown.length).toBeLessThan(500);
    expect(a.shown.length).toBeGreaterThan(380);
    expect(a.html).toContain(`<p>${nw(`<b>전체 500곳 중 ${a.shown.length}곳</b>${DOT}`)} 카드 크기`);
    // the short form's rows have no contact: one wording for it (design-director), as when no row has one
    expect(a.html).toContain(`<p>${items("연락 수단은 각 링크에서 확인해요", "가격 적힌 곳 500곳")}</p>`);
    expect(a.html).not.toContain("연락 수단 적힌 곳");
    for (const g of G) expect(a.html).toContain(`<h3>${g}<span>`);
    // the same with half the prices a word (no amount) and a pill on half the rows: 287 KB whole, so over the height
    // only. Region tails go, no-amount rows first; every region stays; the summary counts all 500
    const odd = (i: number) => Math.floor(i / G.length) % 2 === 1; // half of each region
    const taller = Array.from({ length: 500 }, (_, i) => tallRow(i, odd(i) ? `상담 후 결정 ${fill(20, i)}` : `2.5mg 4개 ¥${(18_000 + i * 10).toLocaleString()}`, i % 2 ? "정리 사이트" : "공식 페이지"));
    const b = drawRowsCard({ title: "긴 이름 500곳", basis: "합성", rows: taller, regulated: true });
    expect(b.short).toBe(true);
    expect(b.bytes).toBeLessThan(250 * 1024); // the height cut it, not the bytes
    expect(b.px).toBeLessThanOrEqual(CARD_HEIGHT_BUDGET);
    expect(b.px).toBeGreaterThan(CARD_HEIGHT_BUDGET - 400); // no more went than needed
    expect(b.shown.length).toBeLessThan(500);
    expect(b.shown.length).toBeGreaterThan(350);
    expect(b.shown.length + b.left.length).toBe(500);
    expect(cardRows(b.html)).toBe(b.shown.length);
    expect(b.html).toContain(`<p>${nw(`<b>전체 500곳 중 ${b.shown.length}곳</b>${DOT}`)} 카드 크기 한도로 지역마다 가격 없는 곳·비싼 곳부터 뺐어요</p>`);
    // priced places are those with an amount, the ones the trim keeps ('상담 후 결정' is no price): 252 of 500
    expect(taller.filter((r) => priceValue(r.price)).length).toBe(252);
    expect(b.html).toContain(`<p>${items("연락 수단은 각 링크에서 확인해요", "가격 적힌 곳 252곳")}</p>`);
    expect(b.html).toContain(`${items("2.5mg 4개 기준 최저 ¥18,000", "최고 ¥22,910")}`); // label and amount on one line
    expect(b.html).toContain(".sum p{text-wrap:pretty}.sum b{color:var(--text);font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}.n{white-space:nowrap;display:inline-block}");
    expect(b.html).toContain(".meta{margin-top:4px;color:var(--text-2);font-size:14px;line-height:1.5;text-wrap:pretty}");
    // pretty only where the dots ride in spans: in the rows a nbsp holds them, and WebKit's pretty breaks before one
    const sheet = b.html.slice(0, b.html.indexOf("</style>"));
    expect([...sheet.matchAll(/([^{}]+)\{[^}]*text-wrap:pretty/g)].map((m) => m[1])).toEqual([".meta", ".sum p"]);
    expect(b.html).not.toContain('class="sep"'); // a price without an amount is no other unit's price either
    for (const g of G) expect(b.html).toContain(`<h3>${g}<span>`);
    expect(b.left.every((r) => !priceValue(r.price))).toBe(true); // no amount went first, in every region
    for (const g of G) expect(b.left.filter((r) => r.group === g).length).toBeGreaterThan(0);
    for (const r of b.shown) expect(b.html).toContain(`<b>${r.name}</b>`);
    for (const r of b.left) expect(b.html).not.toContain(`<b>${r.name}</b>`);
  });

  test("card titles: the page marks a model adds per call go ('(1/2)', '(계속)', '(연락처 순)'); the rest stays", () => {
    expect(cardTitle("도쿄 마운자로 (1/2)")).toBe("도쿄 마운자로");
    expect(cardTitle("일본 마운자로 처방 병원·클리닉 (연락처 순)")).toBe("일본 마운자로 처방 병원·클리닉");
    expect(cardTitle("목록 (2/3) (계속)")).toBe("목록");
    expect(cardTitle("목록（이어서）")).toBe("목록");
    expect(cardTitle("피부과 목록 - 2/3")).toBe("피부과 목록");
    expect(cardTitle("피부과 목록 [2부]")).toBe("피부과 목록");
    expect(cardTitle("서울 (강남)")).toBe("서울 (강남)");
    expect(cardTitle("1/2 가격 약국")).toBe("1/2 가격 약국");
    expect(cardTitle("(1/2)")).toBe("");
    expect(cardTitle("일본 마운자로 처방 클리닉 (도쿄1)")).toBe("일본 마운자로 처방 클리닉"); // server's live run, 287 places
    expect(cardTitle("목록 (p2)")).toBe("목록");
    expect(cardTitle("마운자로 가격 (2026)")).toBe("마운자로 가격 (2026)"); // a year stays
    expect(cardTitle("도쿄·오사카 피부과 20곳 가격 비교")).toBe("도쿄·오사카 피부과 가격 비교"); // this snapshot's live run: 53 in the card
    expect(cardTitle("마운자로 병원 (약 300곳)")).toBe("마운자로 병원");
    expect(cardTitle("24시 약국")).toBe("24시 약국");
    // the pages' titles: what they share, cut back to a word; else the first page's
    expect(rowsCardTitle(["일본 마운자로 처방 클리닉 (도쿄1)", "일본 마운자로 처방 클리닉 (도쿄2)", "일본 마운자로 처방 클리닉 (오사카)"])).toBe("일본 마운자로 처방 클리닉");
    expect(rowsCardTitle(["도쿄 피부과 목록", "도쿄 피부과 리스트"])).toBe("도쿄 피부과");
    expect(rowsCardTitle(["도쿄 마운자로 (도쿄)", "도쿄 마운자로 (오사카)"])).toBe("도쿄 마운자로");
    expect(rowsCardTitle(["ABC 클리닉", "ABD 클리닉"])).toBe("ABC 클리닉");
    // this snapshot's live run: a page per region, the title of each
    expect(rowsCardTitle(["일본 마운자로(マンジャロ) 처방처 — 도쿄 내원 병원", "일본 마운자로 처방처 — 온라인·오사카·후쿠오카", "일본 마운자로(マンジャロ) 처방처 — 도쿄 내원 병원"])).toBe("일본 마운자로(マンジャロ) 처방처");
    expect(rowsCardTitle(["도쿄 피부과", "", "도쿄 피부과 (2/2)"])).toBe("도쿄 피부과");
    expect(rowsCardTitle([])).toBe("");
  });

  test("rows card notes: the answer gives no total and says the card follows, only when a card will follow; the code's line after it", async () => {
    const real = { name: "sys_create_artifact", run: async () => ({ ok: true, summary: "" }) } as unknown as ToolDef;
    const few = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    few.rowsTool(real);
    expect(few.note(0, "final")).not.toContain("카드는 답한 뒤에");
    expect(few.note(0, "final")).not.toContain("총수");
    expect(few.takeLateCard("")).toBe(false); // nothing to list: no card, no line
    expect(few.cardLine()).toBeNull();
    const t = new ExploreTracker(undefined, 0, "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    const tool = t.rowsTool(real)!;
    expect(t.takeCardStep()).toBe(false); // never before the answer
    const final = t.note(0, "final");
    expect(final).toContain("답 본문에는 찾은 곳 수(총수");
    expect(final).toContain("카드는 답한 뒤에 모시가 이어서 만들어요");
    expect(final).not.toContain("찾은 곳 수는 이보다 적지 않아요");
    expect(final).not.toContain("카드에 N곳"); // a sample line here was copied into an answer with a made-up count
    expect(t.takeLateCard("가격대만 말했어요")).toBe(true);
    expect(t.cardStatus()).toBe(CARD_STATUS);
    await tool.run({ rows: [["도쿄", "A", "", "", "", "https://a.jp/", "정리 사이트"]], more: false }, cardCtx().ctx);
    expect(t.cardStatus()).toBe(`${CARD_STATUS} · 1곳`);
    expect(t.cardLine()).toBe("카드에 1곳 전부 정리했어요.");
    expect(t.cardLine()).toBeNull(); // once
  });

  test("notes: start, progress (gate unmet → keep searching), final; voice asks for a short spoken answer", () => {
    const t = new ExploreTracker(undefined, 0);
    expect(t.note(0, "start")).toContain("현지어");
    t.call(search, "web_search", { query: "마운자로 일본" });
    const p = t.note(5_000, "progress");
    expect(p).toContain('"마운자로 일본"');
    expect(p).toContain("아직 답하지 말고");
    expect(p).toContain("남은 도구 호출 11회");
    expect(t.note(0, "final")).toContain("도구를 더 부르지 말고");
    expect(t.note(0, "final")).toContain("공식 페이지에서 확인");
    expect(new ExploreTracker(undefined, 0, "voice").note(0, "final")).toContain("두세 곳만");
  });
});

// ───────────────────────────── loop wiring ─────────────────────────────

const mock = startMockLlm();
afterAll(() => mock.stop());
beforeEach(() => {
  mock.requests.length = 0;
  mock.script.length = 0;
  mock.fallback = { text: ["(no script)"] };
});
const llm = new LlmClient({ apiKey: "sk-explore-test-0123456789abcdef", baseUrl: mock.url, model: "deepseek/deepseek-v4.1-flash-ultrafast" }, { retryDelayMs: 5 });
const deepTurn = createRunTurn(llm, { deepSearch: true });
const plainTurn = createRunTurn(llm);

const searched: string[] = [];
const webSearch: ToolDef<{ query: string }> = {
  name: "web_search",
  description: "Search the web",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  icon: "search",
  explore: "search",
  title: (a) => `'${a.query}' 검색`,
  run: async (a) => {
    searched.push(a.query);
    return { ok: true, summary: "결과 3개", data: { query: a.query, results: [{ title: "스시자로", url: "https://xn--2o2b11q2e68p.site/", snippet: "마운자로 구매 대행" }, { title: "same", url: "https://shared.jp/a" }, { title: a.query, url: `https://q${searched.length}.example.jp/` }] } };
  },
};
const webRead: ToolDef<{ url: string }> = {
  name: "web_read",
  description: "Read a page",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  icon: "link",
  explore: "read",
  title: (a) => `${a.url} 읽기`,
  run: async (a) => ({ ok: true, summary: "읽었어요", data: { url: a.url, title: "스시자로", text: "주문은 카톡으로", contacts: [{ kind: "kakao", value: "sushijaro", source: a.url }] } }),
};
const weather: ToolDef<{ city: string }> = {
  name: "k_weather",
  description: "weather",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  icon: "cloud",
  title: (a) => `${a.city} 날씨`,
  run: async (a) => ({ ok: true, summary: `${a.city} 맑음` }),
};
const TOOLS = [webSearch, webRead, weather] as unknown as ToolDef[];

async function run(turn: typeof deepTurn, userText: string, over: Partial<TurnInput> = {}) {
  const events: AgentEvent[] = [];
  const outcome = await turn({ ctx: fakeCtx(), system: "SYS", history: [], userText, tools: TOOLS, ...over }, (e) => events.push(e));
  return { events, outcome };
}
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, args: JSON.stringify(args) });
const lastUser = (i: number) => {
  const m = mock.requests[i]!.body.messages.at(-1)!;
  return m.role === "user" ? String(m.content) : "";
};

describe("deep search in the loop", () => {
  const ASK = "일본에서 마운자로 살 수 있는 곳 연락처 알려줘";

  test("tools are required until 3 queries with 2 tools, then optional; notes ride on the request only", async () => {
    searched.length = 0;
    mock.script.push(
      { toolCalls: [call("s1", "web_search", { query: "일본 마운자로 구매" }), call("s2", "web_search", { query: "マンジャロ 処方 クリニック" })] },
      { toolCalls: [call("s3", "web_search", { query: "스시자로" })] },
      { toolCalls: [call("r1", "web_read", { url: "https://xn--2o2b11q2e68p.site/" })] },
      { text: ["**스시자로** · 카톡 sushijaro · https://xn--2o2b11q2e68p.site/ · 페이지에서 직접 확인"] },
    );
    const { events, outcome } = await run(deepTurn, ASK);
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["required", "required", "required", "auto"]);
    expect(lastUser(0)).toContain("[찾기 요청]");
    expect(lastUser(1)).toContain("[찾기 진행] 질의 2개");
    expect(lastUser(3)).toContain("충분히 찾았으면 답해요");
    expect(lastUser(3)).toContain("더 찾거나 확인하겠다는 계획은 답에 쓰지 않아요");
    expect(mock.requests[0]!.body.messages[0]!.content).toContain(EXPLORE_RULE.trim().split("\n")[0]!);
    // never stored: the produced messages hold no note
    expect(JSON.stringify(outcome.messages)).not.toContain("[찾기");
    expect(outcome.text).toContain("스시자로");
    // the status line names the query / the site
    const statuses = events.flatMap((e) => (e.type === "status" ? [e.text] : []));
    expect(statuses).toContain("'マンジャロ 処方 クリニック' 찾는 중");
    expect(statuses).toContain("스시자로.site 살펴보는 중");
    // domain de-dup: the second and third searches no longer show sushijaro or shared.jp to the model
    const tool = (id: string) => JSON.parse(String(mock.requests.at(-1)!.body.messages.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === id)!.content));
    expect(tool("s1").data.results.map((r: any) => r.url)).toContain("https://xn--2o2b11q2e68p.site/");
    expect(tool("s2").data.duplicates.domains).toEqual(["xn--2o2b11q2e68p.site", "shared.jp"]);
    expect(tool("s3").data.results.every((r: any) => !/shared\.jp|xn--2o2b11q2e68p/.test(r.url))).toBe(true);
  });

  test("words before a call are the step's plan: not shown, not in the answer; the answer streams once it reads as one", async () => {
    searched.length = 0;
    mock.script.push(
      // the run of 11-17 08:04: this opened the answer, and the reads it promised were never reported
      { text: ["남은 호출로 아직 안 연 정리 사이트와 ", "공식 페이지를 마저 확인할게요."], toolCalls: [call("s1", "web_search", { query: "일본 마운자로 구매" }), call("s2", "web_search", { query: "マンジャロ 処方 クリニック" })] },
      { text: ["스시자로를 찾아볼게요."], toolCalls: [call("s3", "web_search", { query: "스시자로" })] },
      { text: ["열어 볼게요.\n\n"], toolCalls: [call("r1", "web_read", { url: "https://xn--2o2b11q2e68p.site/" })] }, // a break with nothing on
      { text: ["## 마운자로 구매처\n\n", "**스시자로** · 카톡 sushijaro", " · https://xn--2o2b11q2e68p.site/ · 페이지에서 직접 확인"] },
    );
    const { events, outcome } = await run(deepTurn, ASK);
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["required", "required", "required", "auto"]);
    const deltas = events.flatMap((e) => (e.type === "text" ? [e.delta] : []));
    expect(deltas.join("")).toBe(outcome.text);
    expect(outcome.text).toBe("## 마운자로 구매처\n\n**스시자로** · 카톡 sushijaro · https://xn--2o2b11q2e68p.site/ · 페이지에서 직접 확인");
    expect(deltas.length).toBeGreaterThan(1); // a paragraph on: shown before the step ended
    // the model still sees what it said
    expect(JSON.stringify(outcome.messages)).toContain("마저 확인할게요");

    // a step that ends with no call: its words, however short, are the answer
    mock.requests.length = 0;
    mock.script.length = 0;
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" })] },
      { toolCalls: [call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("d", "web_read", { url: "https://q1.example.jp/" })] },
      { text: ["스시자로 한 곳이에요."] },
    );
    expect((await run(deepTurn, ASK)).outcome.text).toBe("스시자로 한 곳이에요.");

    // long words before a call read as the answer and stream (no take-back once shown)
    mock.requests.length = 0;
    mock.script.length = 0;
    const long = "가".repeat(210);
    mock.script.push({ text: [long], toolCalls: [call("a", "web_search", { query: "q1" })] }, { text: ["끝."] });
    expect((await run(deepTurn, ASK)).outcome.text.startsWith(long)).toBe(true);

    // a plain turn is as before: what it says before a call is shown
    mock.requests.length = 0;
    mock.script.length = 0;
    mock.script.push({ text: ["날씨를 볼게요."], toolCalls: [call("w", "k_weather", { city: "서울" })] }, { text: ["서울은 맑아요."] });
    expect((await run(deepTurn, "오늘 서울 날씨 어때?")).outcome.text).toBe("날씨를 볼게요.\n\n서울은 맑아요.");
  });

  test("the call budget ends the search: the last request has no tools and the final note", async () => {
    const small = createRunTurn(llm, { deepSearch: { calls: 4 } });
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("d", "web_search", { query: "q4" })] },
      { text: ["찾은 곳이 없어요. 'q1'~'q4'를 web_search로 찾아봤어요."] },
    );
    await run(small, ASK);
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["required", "required", "none"]);
    expect(lastUser(2)).toContain("[찾기 예산 끝]");
  });

  test("the time budget too", async () => {
    const slowTurn = createRunTurn(llm, { deepSearch: { ms: 30 } });
    const slow: ToolDef = { ...(webSearch as unknown as ToolDef), run: async () => (await Bun.sleep(40), { ok: true, summary: "없음", data: { results: [] } }) };
    mock.script.push({ toolCalls: [call("a", "web_search", { query: "q1" })] }, { text: ["못 찾았어요."] });
    await run(slowTurn, ASK, { tools: [slow, webRead] as unknown as ToolDef[] });
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["required", "none"]);
  });

  test("'전부' over places with no verb is a deep search; the owner's mail or messages read in full are not", async () => {
    const deepNote = (i: number) => String(mock.requests[i]!.body.messages.at(-1)!.content).includes("[찾기");
    // the four that went to a plain turn on 11-17: a deep search, with the '전부' budget
    for (const text of ["일본 마운자로 병원 전부 보여줘", "오사카 마운자로 병원 다 알려줘", "일본 마운자로 병원 빠짐없이", "일본 전국 마운자로 병원 전부 카드로"]) {
      mock.requests.length = 0;
      mock.script.length = 0;
      mock.script.push({ toolCalls: [call("a", "web_search", { query: "マンジャロ 病院 一覧" })] }, { text: ["찾고 있어요."] });
      await run(deepTurn, text);
      expect(mock.requests[0]!.body.tool_choice).toBe("required");
      expect(deepNote(0)).toBe(true);
      expect(String(mock.requests[0]!.body.messages.at(-1)!.content)).toContain("'전부 / 빠짐없이'");
    }
    for (const text of ["메일 전부 읽어줘", "안 읽은 메시지 다 보여줘", "알림 전부 지워줘"]) {
      mock.requests.length = 0;
      mock.script.length = 0;
      mock.script.push({ text: ["네."] });
      await run(deepTurn, text);
      expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["auto"]);
      expect(deepNote(0)).toBe(false);
    }
  });

  test("an open '전부' (a noun no place word names): the first step is auto with the open note; known, it is answered with no tools, card or line; a search begun is the '전부' search", async () => {
    // the model knows the list: one step, no search, no card step (a card tool is offered and a card asked for)
    const kings = "조선의 왕은 모두 27명이에요.\n\n1. 태조\n2. 정종\n3. 태종";
    mock.script.push({ text: [kings] });
    const known = await run(deepTurn, "조선 왕 전부 카드로 알려줘", { tools: [...TOOLS, realArt()] });
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["auto"]);
    expect(lastUser(0)).toContain("[전부 요청]");
    expect(lastUser(0)).not.toContain("[찾기 요청]");
    expect(known.outcome.text).toBe(kings);
    expect(known.outcome.cards).toEqual([]);
    // the model begins a search: from the next step the '전부' search (its start note, required until its gate)
    mock.requests.length = 0;
    mock.script.length = 0;
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "서울 무료 전시회 총정리" })] },
      { toolCalls: [call("b", "web_search", { query: "서울 무료 전시 목록" })] },
      { text: ["서울에서 지금 볼 수 있는 무료 전시를 정리했어요."] },
    );
    const small = createRunTurn(llm, { deepSearch: { exhaustive: { calls: 2 } } });
    await run(small, "서울 무료 전시회 전부 알려줘");
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["auto", "required", "none"]);
    expect(lastUser(0)).toContain("[전부 요청]");
    expect(lastUser(1)).toContain("'전부 / 빠짐없이'");
    expect(lastUser(1)).toContain("예산: 도구 호출 2회");
    // around a spot: a search from the first step, as before
    mock.requests.length = 0;
    mock.script.length = 0;
    mock.script.push({ toolCalls: [call("p", "web_search", { query: "강남역 주차장 목록" })] }, { text: ["강남역 근처 주차장이에요."] });
    await run(small, "강남역 근처 주차장 전부 알려줘");
    expect(mock.requests[0]!.body.tool_choice).toBe("required");
    expect(lastUser(0)).toContain("'전부 / 빠짐없이'");
    // a call: no '찾아볼게요' first on an open turn (the answer may come with no search)
    mock.requests.length = 0;
    mock.script.length = 0;
    mock.script.push({ text: ["조선의 왕은 스물일곱 명이에요."] });
    const voice = await run(deepTurn, "조선 왕 전부 알려줘", { mode: "voice" });
    expect(voice.outcome.text).toBe("조선의 왕은 스물일곱 명이에요.");
  });

  test("a search an open turn began: a card after the answer only for places its lists hold with an area or a contact (films, filings: none, the answer lists them)", () => {
    const search = { name: "web_search", explore: "search" } as unknown as ToolDef;
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const card = { name: "sys_create_artifact", kind: "html" as const };
    const opened = (text: string, data: Record<string, unknown>) => {
      const t = new ExploreTracker(undefined, Date.now(), "text", { text, card, open: true });
      t.call(search, "web_search", { query: text });
      t.result(search, { ok: true, summary: "", data: { results: Array.from({ length: 10 }, (_, i) => ({ url: `https://s${i}.example.kr/`, title: `결과 ${i}` })) } });
      t.call(read, "web_read", { url: data.url });
      t.result(read, { ok: true, summary: "", data });
      t.rowsTool(realArt(), read);
      return t;
    };
    // 2026-11-17: '이번 주 개봉 영화 전부' made a card of 5 re-releases the model sent, and the line said '카드에 5곳 전부'
    const films = ["폭설", "헝거게임 50번째 추첨의 날", "옆에서 숨만 쉬어도 좋아", "광안 : 세자의 여자", "아더 마미", "아름다운 초저녁달", "뮤티니", "저스트 플레이 데드", "심야근무", "원스"];
    const filmList = { url: "https://movie.example.kr/release/week", title: "이번 주 개봉작", items: films.map((n, i) => ({ name: n, key: n.replace(/\s/g, ""), url: `https://movie.example.kr/m/${i}`, text: `${n} · 11.18 개봉 · 92분` })), itemsTotal: films.length };
    const f = opened("이번 주 개봉 영화 전부 알려줘", filmList);
    expect(f.listPlaces()).toBe(0);
    expect(f.note(0, "final")).not.toContain("이어서 카드로");
    expect(f.takeLateCard("")).toBe(false);
    // filings, each linking its DART page and named for the asked noun: entries of a list, no places
    const kinds = ["분기보고서", "기업설명회(IR)개최(안내공시)", "자기주식처분결과보고서", "최대주주등소유주식변동신고서", "현금ㆍ현물배당결정", "장래사업ㆍ경영계획(공정공시)", "기타경영사항(자율공시)", "대규모기업집단현황공시", "수시공시의무관련사항(공정공시)", "풍문또는보도에대한해명"];
    const filings = { url: "https://stock.example.kr/005930/disclosure", title: "삼성전자 공시 목록", items: kinds.map((n, i) => ({ name: n, key: `${i}${n}`, url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=2026110400${i}`, text: `${n} · 2026.11.${10 + i}` })), itemsTotal: 100, nextItemsFrom: 10 };
    const d = opened("삼성전자 이번 달 공시 전부 알려줘", filings);
    // 2026-11-17: answered at a search step, it said '전체 25건 목록은 이어서 카드로 모아 드릴게요' and no card came;
    // the list left half read for the card to read on
    expect(d.note(0, "progress")).toContain("'전부 / 빠짐없이'"); // the step after the search began: its start
    const step = d.note(0, "progress");
    expect(step).toContain("카드가 따라오지 않아요");
    expect(step).not.toContain("이어서 카드로");
    expect(step).not.toContain("직접 읽어 넣어요");
    expect(step).toContain("같은 주소를 그 값으로 이어 읽어요");
    expect(d.takeLateCard("")).toBe(false);
    expect(d.note(0, "final")).not.toContain("이어서 카드로");
    // a list of places: its card, as on a place question
    const halls = ["종로구", "중구", "용산구", "강남구", "관악구", "마포구", "성북구", "서대문구", "송파구", "노원구"];
    const hallList = { url: "https://art.example.kr/free", title: "서울 무료 전시 총정리", items: halls.map((g, i) => ({ name: `기획전 ${i}`, key: `기획전${i}`, area: `서울 ${g}`, url: `https://art.example.kr/e/${i}`, text: `기획전 ${i} · 서울 ${g} · 무료` })), itemsTotal: 30, nextItemsFrom: 10 };
    const h = opened("서울 무료 전시회 전부 알려줘", hallList);
    expect(h.listPlaces()).toBe(10);
    h.note(0, "progress");
    expect(h.note(0, "progress")).toContain("직접 읽어 넣어요"); // its card reads the rest on
    expect(h.note(0, "progress")).not.toContain("카드가 따라오지 않아요");
    expect(h.note(0, "final")).toContain("이어서 카드로");
    expect(h.takeLateCard("")).toBe(true);
    // a card asked for: as asked
    expect(opened("이번 주 개봉 영화 전부 카드로 보여줘", filmList).takeLateCard("")).toBe(true);
    // with no places its notes speak of items: no place, contact or place answer form (a films answer said '연락처까지
    // 확인된 곳은 없고'), a count as listed (it said '9편' over 11), no offer at the end; a place list's are as before
    const start = opened("삼성전자 이번 달 공시 전부 알려줘", filings).note(0, "progress");
    for (const n of [start, step, d.note(0, "final"), f.note(0, "final")]) {
      expect(n).not.toMatch(/곳|연락/);
      expect(n).toContain("답에 실제로 적은 항목 수와 같아야");
      expect(n).toContain("제안하는 문장을 붙이지 않아요");
      expect(n).toContain("카드가 따라오지 않아요");
    }
    expect(start).toContain("1. 정리된 전체 목록부터");
    expect(f.note(0, "final", true)).not.toMatch(/곳|연락/); // the budget spent, the card tool still there: no card asked for
    // the search done: answer, in the same words
    const g = opened("이번 주 개봉 영화 전부 알려줘", filmList);
    for (let i = 0; i < 6; i++) g.call(search, "web_search", { query: `개봉 영화 ${i}` });
    for (let i = 0; i < 16; i++) g.call(read, "web_read", { url: `https://r${i}.example.kr/` });
    g.note(0, "progress");
    expect(g.gateMet(0)).toBe(true);
    expect(g.note(0, "progress")).toContain("목록을 다 모았으면 답해요");
    expect(g.note(0, "progress")).not.toMatch(/곳|연락/);
    const v = new ExploreTracker(undefined, Date.now(), "voice", { text: "이번 주 개봉 영화 전부 알려줘", open: true });
    v.call(search, "web_search", { query: "개봉 영화" });
    v.call(read, "web_read", { url: filmList.url });
    v.result(read, { ok: true, summary: "", data: filmList });
    expect(v.note(0, "final")).toContain("두세 개만");
    expect(v.note(0, "final")).not.toMatch(/곳|연락/);
    expect(h.note(0, "final")).toContain("연락 수단");
    expect(h.note(0, "final")).not.toContain("답에 실제로 적은 항목 수");
  });

  test("a simple question stays as before: no note, tool_choice auto, one step", async () => {
    mock.script.push({ toolCalls: [call("w", "k_weather", { city: "서울" })] }, { text: ["서울은 맑아요."] });
    const { outcome } = await run(deepTurn, "오늘 서울 날씨 어때?");
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["auto", "auto"]);
    expect(mock.requests.every((r) => r.body.messages.at(-1)!.role !== "user" || !String(r.body.messages.at(-1)!.content).includes("[찾기"))).toBe(true);
    expect(outcome.text).toBe("서울은 맑아요.");
  });

  test("web_search / web_read without the explore flag (8cb56af) still take part, by name", async () => {
    const bare = (d: ToolDef) => {
      const { explore: _drop, ...rest } = d as ToolDef & { explore?: unknown };
      return rest as ToolDef;
    };
    expect(exploreKind(bare(webSearch as unknown as ToolDef))).toBe("search");
    expect(exploreKind(bare(webRead as unknown as ToolDef))).toBe("read");
    expect(exploreKind(weather as unknown as ToolDef)).toBeUndefined();
    const small = createRunTurn(llm, { deepSearch: { calls: 4 } });
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("d", "web_read", { url: "https://q1.example.jp/" })] },
      { text: ["찾았어요."] },
    );
    await run(small, ASK, { tools: [bare(webSearch as unknown as ToolDef), bare(webRead as unknown as ToolDef), weather as unknown as ToolDef] });
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["required", "required", "none"]);
  });

  test("off without the runner option or without a search tool", async () => {
    mock.script.push({ text: ["네"] }, { text: ["네"] });
    await run(plainTurn, ASK);
    await run(deepTurn, ASK, { tools: [weather] as unknown as ToolDef[] });
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["auto", "auto"]);
    for (const r of mock.requests) expect(String(r.body.messages[0]!.content)).not.toContain("# 웹에서 찾기");
  });

  test("전부 with a card tool: the wider budget, max_tokens for the card; the answer first, then the rows (card_rows) and the count the code adds; calls over the budget are not run", async () => {
    const artifact = realArt();
    const wide = createRunTurn(llm, { deepSearch: { exhaustive: { calls: 6, minQueries: 3, minCalls: 0 } } });
    const rows = [
      ["도쿄", "A 클리닉", "신주쿠", "2.5mg 4주 ¥9,800", "03-3770-3381", "https://a-clinic.jp/", "공식 페이지"],
      ["도쿄", "(제외)", "", "", "", "https://riss-search.example.ac.jp", ""],
      ["오사카", "B 의원", "우메다", "2.5mg 4주 ¥8,800", "06-0000-0000", "https://b.example.com/", "정리 사이트"],
    ];
    const answer = "도쿄·오사카에서 2.5mg 4주 ¥8,800부터예요. 전체 목록은 이어서 카드로 보여 드려요. 국내로 들여올 때는 반입 기준(처방전·수량)을 확인하세요.";
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "일본 마운자로 병원 가격 비교" }), call("b", "web_search", { query: "マンジャロ 処方 クリニック 料金 比較" }), call("c", "web_search", { query: "mounjaro clinic japan price" })] },
      { toolCalls: [call("r", "web_read", { url: "https://xn--2o2b11q2e68p.site/" })] },
      { toolCalls: [call("d", "web_search", { query: "観光客 韓国語 対応 マンジャロ" }), call("r2", "web_read", { url: "https://q4.example.jp/" })] },
      { text: [answer] },
      { toolCalls: [call("rows", "card_rows", { title: "일본 마운자로 클리닉", basis: "2.5mg 4주 · 11/15 확인", rows, more: false })] },
    );
    const { ctx, saved } = cardCtx();
    const { outcome, events } = await run(wide, `${ASK_ALL} 카드로`, { tools: [...TOOLS, artifact], ctx });
    // 전부 + 연락: two pages with contacts after step 2, so step 3 is still required; the budget then ends the search
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["required", "required", "required", "none", "required"]);
    expect(mock.requests[4]!.body.tools!.map((t) => t.function.name)).toEqual(["card_rows"]);
    for (const i of [0, 1, 2, 3]) {
      const names = (mock.requests[i]!.body.tools ?? []).map((t) => t.function.name);
      expect(names).not.toContain("sys_create_artifact");
      expect(names).not.toContain("card_rows");
    }
    // the answer comes first and says no total: the code adds the card's count after it
    expect(lastUser(3)).toContain("[찾기 예산 끝]");
    expect(lastUser(3)).toContain("답 본문에는 찾은 곳 수(총수, '약 N곳', 'N곳 이상')를 쓰지 않고");
    expect(lastUser(3)).toContain("카드는 답한 뒤에 모시가 이어서 만들어요");
    expect(lastUser(4)).toContain("[카드 만들기] 답은 이미 했어요. 이제 card_rows 하나만");
    expect(lastUser(4)).toContain("[묶음, 이름, 지역, 가격, 연락 수단, 링크, 확인 여부]");
    expect(lastUser(0)).toContain("処方 クリニック 料金 比較");
    for (const r of mock.requests) expect((r.body as { max_tokens?: number }).max_tokens).toBe(DEEP_MAX_TOKENS);
    expect(outcome.text).toBe(`${answer}\n\n카드에 2곳 전부 정리했어요.`);
    expect(outcome.messages.at(-1)).toEqual({ role: "assistant", content: "카드에 2곳 전부 정리했어요." });
    const firstText = events.findIndex((e) => e.type === "text");
    const cardAt = events.findIndex((e) => e.type === "card");
    const lineAt = events.findIndex((e) => e.type === "text" && e.delta.includes("카드에 2곳"));
    expect(firstText).toBeLessThan(cardAt);
    expect(cardAt).toBeLessThan(lineAt);
    // 6 calls: the card keeps the last one, so the 6th search call (r2) did not run
    expect(events.some((e) => e.type === "tool" && e.tool.summary === "찾기 예산을 다 써서 부르지 않았어요")).toBe(true);
    // saved through the tool's saveAgentCard (the store's agent-card option, never the tool's arguments); the model
    // gets a line, not the HTML
    expect(saved).toHaveLength(1);
    expect(saved[0]!.opts).toEqual({ agentCard: true });
    expect(saved[0]!.title).toBe("일본 마운자로 클리닉");
    const back = String((outcome.messages.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "rows") as { content: string }).content);
    expect(back).not.toContain("<");
    expect(back.length).toBeLessThan(400);
    const card = events.find((e) => e.type === "card");
    expect(card && card.type === "card" && card.card).toMatchObject({ type: "artifact", artifactId: "art_1", kind: "html" });
    const html = saved[0]!.content;
    expect(html).toContain("<h2>일본 마운자로 클리닉</h2>");
    expect(html).not.toContain("example");
    expect(html).not.toContain("(제외)");
    expect(html).toContain("<span>1곳</span>");
    expect(html).toContain(`<p>${nw("<b>2곳</b>")}</p><p>${items("2.5mg 4주 기준 최저 ¥8,800", "최고 ¥9,800")}</p>`);
    expect(html).not.toContain("0000"); // the 0000 number is no contact
    expect(html).toContain(nw(`연락 수단 적힌 곳 1곳${DOT}`));
    expect(html).toContain("반입 기준");
  });

  test("rows card: after the answer, rows in pages (card_rows, required), drawn and saved; '카드 만드는 중 · N곳' meanwhile; a failed save once more; the summary's lowest is 2000엔, 1000엔 under a quarter of the rows' median", async () => {
    const artifact = realArt();
    const row = (i: number) => [i < 6 ? "도쿄" : "오사카", `클리닉 ${i}`, "역 앞", `${(12 - i) * 1000}엔`, `03-3770-33${10 + i}`, `https://c${i}.clinic.jp/`, "정리 사이트"];
    const wide = createRunTurn(llm, { deepSearch: { exhaustive: { calls: 20, minQueries: 3, minCalls: 0 } } });
    const answer = "도쿄·오사카 피부과는 1000엔부터예요. 전체는 이어서 카드로 보여 드려요.";
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("r", "web_read", { url: "https://q1.example.jp/" })] },
      { text: [answer] },
      { toolCalls: [call("p1", "card_rows", { title: "도쿄·오사카 피부과 (1/2)", rows: [0, 1, 2, 3, 4, 5].map(row), more: true })] },
      { toolCalls: [call("p2", "card_rows", { title: "도쿄·오사카 피부과 (2/2)", rows: [5, 6, 7, 8, 9, 10, 11].map(row), more: false })] }, // row 5 again: one row
      { toolCalls: [call("p3", "card_rows", { rows: [], more: false })] },
    );
    const { ctx, saved } = cardCtx({ failFirst: true });
    const { outcome, events } = await run(wide, "도쿄·오사카 피부과 전부 가격순 카드로", { tools: [...TOOLS, artifact], ctx });
    expect(mock.requests).toHaveLength(6);
    expect(mock.requests[2]!.body.tool_choice).toBe("auto"); // the search may stop: the model answers when it is done
    for (const i of [0, 1, 2]) expect((mock.requests[i]!.body.tools ?? []).map((t) => t.function.name)).not.toContain("card_rows");
    for (const i of [3, 4, 5]) {
      expect(mock.requests[i]!.body.tools!.map((t) => t.function.name)).toEqual(["card_rows"]);
      expect(mock.requests[i]!.body.tool_choice).toBe("required");
      expect(lastUser(i)).toContain("[카드 만들기]");
    }
    expect(lastUser(4)).toContain("지금까지 6곳을 받았어요. 7번째 곳부터 이어서 보내요");
    const statuses = events.flatMap((e) => (e.type === "status" ? [e.text] : []));
    expect(statuses).toContain(CARD_STATUS);
    expect(statuses).toContain(`${CARD_STATUS} · 6곳`);
    // the first save failed (the store threw): the second came from the same rows
    const back = String(mock.requests[5]!.body.messages.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "p2")!.content);
    expect(back).toContain("save_failed");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.opts).toEqual({ agentCard: true });
    const html = saved[0]!.content;
    expect(html).toContain(nw("<b>12곳</b>"));
    expect(html).toContain("<h2>도쿄·오사카 피부과</h2>"); // the model's page marks are not the card's title
    expect((html.match(/<li>/g) ?? []).length).toBe(12);
    expect(html).toContain("<h3>도쿄<span>6곳</span></h3>");
    expect(html.indexOf("클리닉 5")).toBeLessThan(html.indexOf("클리닉 0")); // by price within the group
    // 1000엔 is under a quarter of the median (6500엔): the summary's lowest is 2000엔, its row stays (summaryRange)
    expect(html).toContain(`<p>${nw("<b>12곳</b>")}</p><p>${items("최저 2000엔", `최고 12000엔${DOT}`)} ${nw("크게 다른 값 1곳은")} ${nw("최저·최고에서 뺐어요")}</p>`);
    expect(html).toContain("<b>1000엔</b>");
    expect(html).toContain(`<p>${nw("확인: 모두 정리 사이트")}</p>`);
    expect(outcome.text).toBe(`${answer}\n\n카드에 12곳 전부 정리했어요.`);
  });

  test("rows card in the loop: page after page while the turn has time (past the six once asked for whatever the clock said); every row on the card", async () => {
    const row = (i: number) => ["도쿄", `클리닉 ${i}`, "역 앞", `${1000 + i}엔`, "", `https://c${i}.clinic.jp/`, "정리 사이트"];
    const wide = createRunTurn(llm, { deepSearch: { exhaustive: { calls: 20, minQueries: 3, minCalls: 0 } } });
    const pages = 8;
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("r", "web_read", { url: "https://q1.example.jp/" })] },
      { text: ["도쿄 피부과예요. 전체는 이어서 카드로 보여 드려요."] },
      ...Array.from({ length: pages }, (_, p) => ({
        toolCalls: [call(`p${p}`, "card_rows", { rows: Array.from({ length: 10 }, (_, i) => row(p * 10 + i)), more: p < pages - 1 })],
      })),
    );
    const { ctx, saved } = cardCtx();
    const { outcome } = await run(wide, "도쿄·오사카 피부과 전부 가격순 카드로", { tools: [...TOOLS, realArt()], ctx });
    expect(mock.requests).toHaveLength(3 + pages);
    expect(lastUser(3 + 6)).toContain("지금까지 60곳을 받았어요.");
    expect(saved).toHaveLength(1);
    expect(namesOn(saved[0]!.content)).toHaveLength(pages * 10);
    expect(outcome.text).toEndWith(`카드에 ${pages * 10}곳 전부 정리했어요.`);
  });

  test("전부: the model's own card tool is neither offered nor run (a call anyway is refused); the one card is the code's, after the answer", async () => {
    const row = (i: number) => [i < 6 ? "도쿄" : "오사카", `클리닉 ${i}`, "역 앞", `${(12 - i) * 1000}엔`, `03-3770-33${10 + i}`, `https://c${i}.clinic.jp/`, "정리 사이트"];
    const own = `<div class="d">${Array.from({ length: 9 }, (_, i) => `<a href="https://c${i}.clinic.jp/"><b>클리닉 ${i}</b><em>${i}000엔</em></a>`).join("")}</div>`;
    const wide = createRunTurn(llm, { deepSearch: { exhaustive: { calls: 20, minQueries: 3, minCalls: 0 } } });
    const answer = "도쿄·오사카 피부과는 1000엔부터예요. 전체는 이어서 카드로 보여 드려요.";
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      // the model draws its own card first (an earlier turn's habit): not run
      { toolCalls: [call("own", "sys_create_artifact", { title: "피부과", kind: "html", content: own }), call("r", "web_read", { url: "https://q1.example.jp/" })] },
      { text: [answer] },
      { toolCalls: [call("p1", "card_rows", { title: "도쿄·오사카 피부과", rows: Array.from({ length: 12 }, (_, i) => row(i)), more: false })] },
    );
    const { ctx, saved } = cardCtx();
    const { outcome } = await run(wide, "도쿄·오사카 피부과 전부 가격순 카드로", { tools: [...TOOLS, realArt()], ctx });
    expect(mock.requests).toHaveLength(4);
    for (const r of mock.requests) expect((r.body.tools ?? []).map((t) => t.function.name)).not.toContain("sys_create_artifact");
    const back = String(mock.requests[2]!.body.messages.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "own")!.content);
    expect(back).toContain("card_after_answer");
    expect(back).not.toContain("<");
    expect(saved).toHaveLength(1); // the code's card only
    expect(saved[0]!.opts).toEqual({ agentCard: true });
    expect((saved[0]!.content.match(/<li>/g) ?? []).length).toBe(12);
    expect(outcome.text).toBe(`${answer}\n\n카드에 12곳 전부 정리했어요.`);
  });

  test("전부: the steps offer the search's tools; a briefing tool stays out (it put a card in three '전부' answers), and other turns keep it", async () => {
    const briefing = { name: "sys_show_briefing", description: "briefing", parameters: { type: "object", properties: {} }, icon: "list", title: () => "브리핑", run: async () => ({ ok: true, summary: "브리핑" }) } as unknown as ToolDef;
    mock.script.push({ toolCalls: [call("a", "web_search", { query: "q1 一覧 목록" })] }, { text: ["찾은 곳이에요."] });
    await run(deepTurn, ASK_ALL, { tools: [...TOOLS, briefing] });
    expect(mock.requests.length).toBeGreaterThan(1);
    for (const r of mock.requests) {
      const names = (r.body.tools ?? []).map((t) => t.function.name);
      if (names.length) expect(names).toEqual(["web_search", "web_read", "k_weather"]);
    }
    mock.requests.length = 0;
    mock.script.push({ toolCalls: [call("a", "web_search", { query: "q1" })] }, { text: ["찾았어요."] });
    await run(deepTurn, DENTIST, { tools: [...TOOLS, briefing] });
    expect((mock.requests[0]!.body.tools ?? []).map((t) => t.function.name)).toContain("sys_show_briefing");
  });

  test("card_rows: a page of places all sent before draws the card at once; each page's answer names the last places taken and the repeats", async () => {
    const t = new ExploreTracker(undefined, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    const { ctx, saved } = cardCtx();
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    const rows = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => ["도쿄", `클리닉 ${a + i}`, "", "¥9,800", "", `https://c${a + i}.clinic.jp/`, ""]);
    const r1 = await rt.run({ rows: rows(0, 20), more: true }, ctx);
    expect(r1.data).toMatchObject({ received: 20, total: 20 });
    expect((r1.data as { message: string }).message).toBe("20곳 받았어요. 마지막으로 받은 곳: '클리닉 17', '클리닉 18', '클리닉 19'. 그다음 곳부터 이어서 보내요(이미 보낸 곳은 다시 보내지 않아요).");
    const r2 = await rt.run({ rows: rows(15, 30), more: true }, ctx);
    expect(r2.data).toMatchObject({ received: 10, skipped: 5, total: 30 });
    expect((r2.data as { message: string }).message).toContain("30곳 받았어요(이번 15행 중 5행은 이미 받은 곳이라 뺐어요). 마지막으로 받은 곳: '클리닉 27', '클리닉 28', '클리닉 29'.");
    expect(saved).toHaveLength(0);
    // all sent before, though it says more: the list is done, drawn now (a run sent two such pages, about 70 s)
    const r3 = await rt.run({ rows: rows(0, 30), more: true }, ctx);
    expect(r3.ok).toBe(true);
    expect(saved).toHaveLength(1);
    expect(t.drawn()?.rows).toBe(30);
  });

  test("card_rows past 900 rows: every row is kept (the cards go on); each page after the first comes while the turn has time for it (up to the guard), else the card is drawn and the line says time stopped it", async () => {
    const rows = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => ["도쿄", `클리닉 ${a + i}`, "", "¥9,800", "", `https://c${a + i}.clinic.jp/`, ""]);
    const t = new ExploreTracker(undefined, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    const { ctx, saved } = cardCtx();
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    expect((await rt.run({ rows: rows(0, 600), more: true }, ctx)).data).toMatchObject({ total: 600 });
    // 20 repeats, then 330 new: all kept, past CARD_ALL_ROWS, and asked for the rest
    expect((await rt.run({ rows: [...rows(580, 600), ...rows(600, 930)], more: true }, ctx)).data).toMatchObject({ received: 330, skipped: 20, total: 930 });
    const r = await rt.run({ rows: rows(930, 1000), more: false }, ctx);
    expect(r.ok).toBe(true);
    expect(t.drawn()).toMatchObject({ rows: 1000, left: [] });
    expect(namesOn(saved.map((c) => c.content).join(""))).toHaveLength(1000);
    expect(saved).toHaveLength(1); // short rows: one card holds the 1000
    expect(t.cardLine()).toBe("카드에 1000곳 전부 정리했어요.");
    expect(t.note(0, "final")).toContain("카드에 1000곳을 담아 이미 띄웠어요(모시가 카드의 행을 센 수).");
    // pages in a turn with time: each taken; the last says done, all of them drawn
    const pages = async (x: ExploreTracker, n: number, last = false) => {
      const c = cardCtx();
      const rx = x.rowsTool(realArt())!;
      expect(x.takeLateCard("")).toBe(true);
      let sent = 0;
      for (let i = 0; i < n && !x.drawn(); i++, sent++) {
        x.call(rx, "card_rows", {}); // the loop counts each page before it runs
        await rx.run({ rows: rows(i * 20, i * 20 + 20), more: !(last && i === n - 1) }, c.ctx);
      }
      return sent;
    };
    const fresh = new ExploreTracker(undefined, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    expect(await pages(fresh, 9, true)).toBe(9);
    expect(fresh.rowsPending()).toBe(false);
    expect(fresh.cardLine()).toBe("카드에 180곳 전부 정리했어요.");
    // a model that never says done: drawn at the guard
    const endless = new ExploreTracker(undefined, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    expect(await pages(endless, CARD_PAGES_GUARD + 5)).toBe(CARD_PAGES_GUARD);
    expect(endless.drawn()?.rows).toBe(CARD_PAGES_GUARD * 20);
    // a turn too old for another page (none ends by CARD_READ_BY_MS), the first included: drawn at the first page, the
    // line says time stopped it; one with just time for the pages takes them
    const late = new ExploreTracker(undefined, Date.now() - (CARD_READ_BY_MS - CARD_PAGE_MS) - 2_000, "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    expect(await pages(late, 9)).toBe(1);
    expect(late.cardLine()).toBe("카드에 20곳을 담았어요. 시간 안에 받을 수 있는 만큼만 받아서, 목록 밖에서 찾은 곳 중 일부는 카드에 넣지 못했어요.");
    const inTime = new ExploreTracker(undefined, Date.now() - (CARD_READ_BY_MS - CARD_PAGE_MS) + 10_000, "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    expect(await pages(inTime, 7, true)).toBe(7);
    expect(inTime.cardLine()).toBe("카드에 140곳 전부 정리했어요.");
    // a card short of what the answer said: held once for the rest while the turn has time, not in a turn without it
    const short = async (started: number) => {
      const x = new ExploreTracker(undefined, started, "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
      const c = cardCtx();
      const rx = x.rowsTool(realArt())!;
      expect(x.takeLateCard("모두 300곳이에요.")).toBe(true);
      x.call(rx, "card_rows", {});
      const r = await rx.run({ rows: rows(0, 20), more: false }, c.ctx);
      return { r, pending: x.rowsPending(), saved: c.saved.length };
    };
    expect(await short(Date.now())).toMatchObject({ r: { ok: false, data: { error: expect.stringContaining("card_too_short") } }, pending: true, saved: 0 });
    expect(await short(Date.now() - CARD_READ_BY_MS)).toMatchObject({ r: { ok: true }, pending: false, saved: 1 });
    // the last page said more, nothing named (no list read; '전부': the lists' places would be the card's own, so what
    // is off it came from elsewhere): the same words without names
    const p = new ExploreTracker(undefined, 0, "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    const c2 = cardCtx();
    const rp = p.rowsTool(realArt())!;
    expect(p.takeLateCard("")).toBe(true);
    p.call(rp, "card_rows", {}); // the loop counts each page before it runs
    await rp.run({ rows: rows(0, 40), more: true }, c2.ctx);
    expect(c2.saved).toHaveLength(1);
    expect(p.cardLine()).toBe("카드에 40곳을 담았어요. 시간 안에 받을 수 있는 만큼만 받아서, 목록 밖에서 찾은 곳 중 일부는 카드에 넣지 못했어요.");
    // a page of repeats with more:true is the list's end: all
    const e = new ExploreTracker(undefined, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    const c3 = cardCtx();
    const re = e.rowsTool(realArt())!;
    expect(e.takeLateCard("")).toBe(true);
    await re.run({ rows: rows(0, 20), more: true }, c3.ctx);
    await re.run({ rows: rows(0, 20), more: true }, c3.ctx);
    expect(e.cardLine()).toBe("카드에 20곳 전부 정리했어요.");
  });

  test("전부: card_rows cut by the clock: the places of the lists read that no row matches (by phone, link or name) come from the list, the others are not drawn twice", async () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const t = new ExploreTracker(undefined, 0, "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    const items = [
      { name: "아몬드 클리닉", key: "아몬드", url: "https://almond.clinic/" },
      { name: "재팬넷 클리닉", key: "재팬넷", tel: "0362339010", url: "https://excelkospi.ai/c/2" },
      { name: "링크만 같은 곳", key: "링크만같은곳", url: "https://same-link.jp/a" },
      { name: "MBD 도쿄 에비스원 클리닉", key: "mbd도쿄에비스원", url: "https://excelkospi.ai/c/4" }, // its core (the kind word moved)
      { name: "스이 클리닉 (에사카)", key: "스이에사카", url: "https://excelkospi.ai/c/5" }, // its whole name
      ...Array.from({ length: 12 }, (_, i) => ({ name: `남은 클리닉 ${i}`, key: `남은${i}`, url: `https://left${i}.jp/` })),
    ];
    t.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro", title: "마운자로 병원 목록", items, itemsTotal: items.length } });
    const { ctx } = cardCtx();
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    const sent = [
      ["도쿄", "아몬드 클리닉 이치가야", "", "¥17,500", "", "https://almond.clinic/ko/", ""], // its name
      ["도쿄", "JNC 긴자", "", "", "+81 3-6233-9010", "https://jnc.example.jp/", ""], // its phone, another script
      ["도쿄", "다른 이름", "", "", "", "https://same-link.jp/a/", ""], // its link
      ["도쿄", "MBD 클리닉 도쿄 에비스원", "", "", "", "https://mbd.example.jp/", ""],
      ["오사카", "스이 클리닉", "", "", "", "https://sui.example.jp/", ""],
    ];
    // a turn too old for another page: more:true at the first is drawn as cut
    t.call(rt, "card_rows", {});
    await rt.run({ rows: [...sent, ...[1, 2, 3, 4, 5].map((i) => ["오사카", `행 ${i}`, "", "", "", `https://row${i}.jp/`, ""])], more: true }, ctx);
    const line = t.cardLine()!;
    expect(line).toBe("카드에 22곳을 담았어요. 시간 안에 받을 수 있는 만큼만 받아서, 목록 밖에서 찾은 곳 중 일부는 카드에 넣지 못했어요.");
    expect(t.drawn()).toMatchObject({ rows: 22, left: [], listed: 12 });
    const names = namesOn(lastCard(ctx));
    expect(names.sort()).toEqual([...sent.map((r) => r[1]!), ...Array.from({ length: 5 }, (_, i) => `행 ${i + 1}`), ...Array.from({ length: 12 }, (_, i) => `남은 클리닉 ${i}`)].sort());
  });

  test("전부: a card not cut whose rows left out many of the lists' places (the model stopped) holds them from the lists; a card not for '전부' holds the rows", async () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const no = (i: number) => String(i).padStart(3, "0"); // no name inside another
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `남은 클리닉 ${no(i)}`, key: `남은${no(i)}`, url: `https://left${i}.jp/` }));
    const sent = (n: number) => Array.from({ length: n }, (_, i) => ["도쿄", `남은 클리닉 ${no(i)}`, "", "", "", `https://left${i}.jp/`, ""]);
    const lineAfter = async (listed: number, rows: number, text = `${ASK_ALL} 카드로`) => {
      const t = new ExploreTracker(undefined, 0, "text", { text, card: { name: "sys_create_artifact", kind: "html" } });
      t.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro", title: "마운자로 병원 목록", items: items(listed), itemsTotal: listed } });
      const { ctx } = cardCtx();
      const rt = t.rowsTool(realArt())!;
      expect(t.takeLateCard("")).toBe(true);
      for (let i = 0; i < 2 && !t.drawn(); i++) await rt.run({ rows: sent(rows), more: false }, ctx);
      expect(t.drawn()).not.toBeNull();
      return t.cardLine();
    };
    // 40 listed, 25 sent: the 15 come from the list
    expect(await lineAfter(40, 25)).toBe("카드에 40곳 전부 정리했어요.");
    expect(await lineAfter(34, 25)).toBe("카드에 34곳 전부 정리했어요.");
    expect(await lineAfter(70, 58)).toBe("카드에 70곳 전부 정리했어요.");
    expect(await lineAfter(70, 0)).toBe("카드에 70곳 전부 정리했어요."); // no row of the model's at all
    // not '전부' (a card of what the answer named): as before
    expect(await lineAfter(40, 25, "도쿄 치과 카드로")).toBe("카드에 25곳 전부 정리했어요.");
  });

  const ROW_PAGES = Array.from({ length: 5 }, (_, i) => `행 ${i + 1}`);
  /** a '전부' html card cut by the clock (a turn too old for another page, more: true): its end line and the names on it */
  const cutCard = async (t: ExploreTracker, sent: string[][]) => {
    const { ctx } = cardCtx();
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    t.call(rt, "card_rows", {});
    await rt.run({ rows: [...sent, ...ROW_PAGES.map((n, i) => ["오사카", n, "", "", "", `https://row${i + 1}.jp/`, ""])], more: true }, ctx);
    return { line: t.cardLine(), names: namesOn(lastCard(ctx)) };
  };
  const readOf = { name: "web_read", explore: "read" } as unknown as ToolDef;
  const listRead = (t: ExploreTracker, url: string, title: string, items: Record<string, unknown>[]) =>
    t.result(readOf, { ok: true, summary: "", data: { url, title, items, itemsTotal: items.length } });

  test("a card not for '전부' that left places off says how to ask for them all, in words that start a '전부' search; a '전부' card never does", async () => {
    const items = Array.from({ length: 17 }, (_, i) => ({ name: `치과 ${String(i).padStart(2, "0")}`, key: `치과${String(i).padStart(2, "0")}`, url: `https://d${i}.jp/` }));
    const sent = items.slice(0, 5).map((it) => ["도쿄", it.name, "", "", "", it.url, ""]);
    const cut = async (text: string) => {
      const t = new ExploreTracker(undefined, 0, "text", { text, card: { name: "sys_create_artifact", kind: "html" } });
      listRead(t, "https://dental.example.jp/tokyo", "도쿄 치과 목록", items);
      const { ctx } = cardCtx();
      const rt = t.rowsTool(realArt())!;
      expect(t.takeLateCard("")).toBe(true);
      t.call(rt, "card_rows", {});
      await rt.run({ title: "도쿄 치과", rows: sent, more: true }, ctx); // a turn without time for another page
      return t.cardLine()!;
    };
    const names = items.slice(5, 15).map((it) => it.name).join(", ");
    expect(await cut("도쿄 치과 카드로")).toBe(
      `카드에 5곳을 담았어요. 시간 안에 받을 수 있는 만큼만 받아서, 카드에 넣지 못한 곳이 12곳 더 있어요: ${names} 외 2곳.\n빠진 곳까지 전부 보시려면 '도쿄 치과 목록 전부 보여줘'라고 말씀해 주세요.`,
    );
    expect(exploreIntent("도쿄 치과 목록 전부 보여줘")).toBe(true);
    // '전부': the lists' places are on the card, no such line
    expect(await cut("도쿄 치과 전부 카드로")).not.toContain("보시려면");
    // the words: the title with '목록 전부 보여줘', cut at a word; one that would not start a '전부' search, or none, as
    // '목록 전부 보여줘'
    expect(allAgain("찾은 곳 목록")).toBe("찾은 곳 목록 전부 보여줘");
    expect(allAgain("일본 마운자로 처방 클리닉 가격·연락처 (정리 사이트 기준)")).toBe("일본 마운자로 처방 클리닉 가격·연락처 목록 전부 보여줘");
    expect(allAgain("일본 전국 마운자로 처방 클리닉 가격과 연락처 한눈에보기 정리")).toBe("일본 전국 마운자로 처방 클리닉 가격과 연락처 목록 전부 보여줘");
    expect(allAgain("도쿄 치과 (가격순, 연락처 있는 곳만 모아서 정리한 목록")).toBe("도쿄 치과 목록 전부 보여줘");
    expect(allAgain("도쿄 (신주쿠) 치과")).toBe("도쿄 치과 목록 전부 보여줘");
    expect(allAgain("'할 일'")).toBe("목록 전부 보여줘"); // '할 일 목록 전부 보여줘' is the owner's own
    expect(allAgain("")).toBe("목록 전부 보여줘");
    expect(exploreIntent("목록 전부 보여줘")).toBe(true);
  });

  test("전부: a list's region, rest, kind and dose heads and a contact's label are never places, counted or named — a stats table by region read first, heads mixed into a list", async () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    // a stats table by region (aitoolog's, 2026-11-16: '도쿄, 오사카, … 규슈 기타(나가사키 등)' were 10 of 332 'places')
    const regions = ["도쿄", "오사카", "교토", "고베", "후쿠오카", "기타큐슈", "규슈 기타(나가사키 등)", "삿포로", "나고야", "오키나와(나하)"];
    listRead(t, "https://jaro.example.kr/stats/", "일본 마운자로 지역별 통계", [
      ...regions.map((r, i) => ({ name: r, key: r.replace(/[\s()]/g, ""), url: `https://jaro.example.kr/r${i}/`, text: `${29 - i}% · 24 · 3 · 1 · ¥19,200 (25개)` })),
      { name: "5mg · 4개(1개월)", key: "5mg4개1개월", area: "2.5mg", text: "83개 · ¥4,400" },
    ]);
    const no = (i: number) => String(i).padStart(3, "0");
    const areas = ["도쿄", "도쿄", "도쿄", "도쿄", "오사카", "오사카", "오사카", "오사카", "아소", "아소", "아소", "아소", "이부스키", "이부스키"];
    const clinics = areas.map((a, i) => ({ name: `미라이 클리닉 ${no(i)}`, key: `미라이${no(i)}`, url: `https://dir.example.kr/mounjaro/clinic/c${i}`, text: `${a} · 역 앞 · 8,000엔` }));
    const at = (slug: string) => `https://dir.example.kr/mounjaro/clinic/${slug}`;
    listRead(t, "https://dir.example.kr/mounjaro", "일본 마운자로 병원 목록", [
      ...clinics,
      // heads: in the list's own folder, so only their names tell
      { name: "도쿄", key: "도쿄", url: at("tokyo"), text: "24곳" },
      { name: "東京都 (13442)", key: "東京都13442", url: at("pref13") },
      { name: "서울 →", key: "서울", url: at("seoul") },
      { name: "강남구", key: "강남구", url: at("gangnam") },
      { name: "Tokyo", key: "tokyo", url: at("tokyo-en") },
      { name: "규슈 기타(나가사키 등)", key: "규슈기타나가사키등", url: at("kyushu") },
      { name: "그 밖", key: "그밖", url: at("other") },
      { name: "온라인 진료", key: "온라인진료", url: at("online") },
      { name: "피부과 클리닉", key: "피부과", url: at("derm") },
      { name: "10mg", key: "10mg", url: at("10mg") },
      { name: "아소", key: "아소", url: at("aso") }, // four entries give it as their area
      // a group of places, kind word and all (glp1.co.kr's city rows, 2026-11-16)
      { name: "후쿠오카 병원 약 81,800~547,000원 (9,800~65,560엔) 2.5mg 4펜 · 클리닉 39…", key: "후쿠오카약81800547000원", url: at("fukuoka"), text: "후쿠오카 병원 약 81,800~547,000원 · 클리닉 39곳 · 한국어 응대 0곳" },
      { name: "돗토리 병원 1곳 · 약 188,000원 (22,500엔)", key: "돗토리1곳약188000원", url: at("tottori") },
      // places: a kind word, a phone, a contact, another site's link, names that only end like a region; a region two
      // entries give as their area is not a head yet
      { name: "기타 클리닉", key: "기타", url: at("kita") },
      { name: "후쿠오카", key: "후쿠오카", url: at("fukuoka-tel"), tel: "0927123456" },
      { name: "나고야", key: "나고야", url: at("nagoya-line"), contacts: ["LINE @nagoya"] },
      { name: "삿포로", key: "삿포로", url: "https://sapporo-shop.example.jp/" },
      { name: "이부스키", key: "이부스키", url: at("ibusuki") },
      { name: "긴자스시", key: "긴자스시", url: at("ginza-sushi") },
      { name: "麺道", key: "麺道", url: at("mendo") },
      { name: "우메다 스킨 클리닉 (口コミ 25件)", key: "우메다스킨口コミ25件", url: at("umeda-skin"), text: "오사카 · 스킨 클리닉 25件 口コミ" }, // reviews, not places
      { name: "빌라 뷰티 클리닉 하카타점", key: "빌라뷰티하카타점", url: at("villa"), text: "하카타역 앞 · ¥5,000 · 빌라 뷰티 클리닉 전국 2곳" }, // a chain's size
      // a table's address cells (on-clinic.jp's operator rows, 2026-11-16); the clinic named by its street keeps its place
      { name: "東京都渋谷区渋谷2-24-12 渋谷スクランブルスクエア 24F", key: "東京都渋谷区渋谷2-24-12", url: at("op-1"), tel: "03-0000-0001" },
      { name: "埼玉県さいたま市大宮区大門町2丁目118番地", key: "埼玉県さいたま市大宮区大門町2丁目118番地", url: at("op-2") },
      { name: "서울특별시 강남구 테헤란로 123", key: "서울특별시강남구테헤란로123", url: at("op-3") },
      { name: "梅田クリニック 大阪市北区梅田1-2-3", key: "梅田大阪市北区梅田123", url: at("umeda-1") }, // name and address glued
      // a contact's label: its phone is the page's own
      { name: "전화", key: "전화", tel: "0120151929", text: ": 0120-151-929" },
      { name: "외국어 전화：", key: "외국어전화", tel: "0335550101" },
    ]);
    expect(t.listPlaces()).toBe(24); // 14 clinics, 기타 클리닉, 후쿠오카, 나고야, 삿포로, 이부스키, 긴자스시, 麺道, 우메다 스킨, 빌라 뷰티, 梅田クリニック
    const sent = clinics.slice(0, 12).map((c) => ["도쿄", c.name, "", "¥8,000", "", c.url, ""]);
    // the card holds the places (the rows, and the list's others from the list), never a head or a label
    const { line, names } = await cutCard(t, sent);
    expect(line).toBe("카드에 29곳을 담았어요. 시간 안에 받을 수 있는 만큼만 받아서, 목록 밖에서 찾은 곳 중 일부는 카드에 넣지 못했어요.");
    expect(names.sort()).toEqual(
      [
        ...sent.map((r) => r[1]!),
        ...ROW_PAGES,
        ...["미라이 클리닉 012", "미라이 클리닉 013", "기타 클리닉", "후쿠오카", "나고야", "삿포로", "이부스키", "긴자스시", "麺道", "우메다 스킨 클리닉 (口コミ 25件)", "빌라 뷰티 클리닉 하카타점", "梅田クリニック 大阪市北区梅田1-2-3"],
      ].sort(),
    );
  });

  test("전부: a list entry whose link leaves the list's detail pages, holds other entries' links or is a list read is a head, unless its name says it is a place", async () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    const no = (i: number) => String(i).padStart(3, "0");
    const clinics = Array.from({ length: 10 }, (_, i) => ({ name: `코요미 ${no(i)}`, key: `코요미${no(i)}`, url: `https://navi.example.jp/ko/clinic/k${i}/`, area: "渋谷区" }));
    listRead(t, "https://navi.example.jp/ko/clinic/fukuoka-all/", "후쿠오카 병원 8곳", Array.from({ length: 8 }, (_, i) => ({ name: `후쿠 클리닉 ${i}`, key: `후쿠${i}`, url: `https://navi.example.jp/ko/clinic/f${i}/` })));
    listRead(t, "https://navi.example.jp/ko/", "일본 마운자로 클리닉 비교", [
      ...clinics,
      { name: "추천 랭킹", key: "추천랭킹", url: "https://navi.example.jp/ko/ranking/" }, // out of /ko/clinic/
      { name: "간토 지역", key: "간토지역", url: "https://navi.example.jp/ko/clinic/kanto/" }, // holds the two below
      { name: "간토 A", key: "간토a", url: "https://navi.example.jp/ko/clinic/kanto/a/", area: "千代田区" },
      { name: "간토 B", key: "간토b", url: "https://navi.example.jp/ko/clinic/kanto/b/", area: "港区" },
      { name: "후쿠오카 모음", key: "후쿠오카모음", url: "https://navi.example.jp/ko/clinic/fukuoka-all/" }, // a list read
      // places: out of the folder with a kind word, or with a name too long for a heading
      { name: "신주쿠 아이 클리닉", key: "신주쿠아이", url: "https://navi.example.jp/ko/shinjuku-eye/" },
      { name: "아오야마 스킨 앤 바디 뷰티 라운지 도쿄", key: "아오야마스킨앤바디뷰티라운지도쿄", url: "https://navi.example.jp/ko/aoyama/" },
    ]);
    expect(t.listPlaces()).toBe(22); // the 8 read, 10 + 간토 A, B + the two
    const sent = [...clinics.slice(0, 9), { name: "간토 A", url: "https://navi.example.jp/ko/clinic/kanto/a/" }].map((c) => ["도쿄", c.name, "", "", "", c.url, ""]);
    const { names } = await cutCard(t, sent);
    expect(names.sort()).toEqual(
      [...sent.map((r) => r[1]!), ...ROW_PAGES, ...Array.from({ length: 8 }, (_, i) => `후쿠 클리닉 ${i}`), "코요미 009", "간토 B", "신주쿠 아이 클리닉", "아오야마 스킨 앤 바디 뷰티 라운지 도쿄"].sort(),
    );
  });

  test("전부: a list of mostly heads (a region index) holds only the entries that look like places; one that hardly holds places (a forum's posts, a clinic's menu) and a price list hold none: none of theirs reach the card", async () => {
    const no = (i: number) => String(i).padStart(3, "0");
    const lineWith = async (extra: { url: string; title: string; items: Record<string, unknown>[] }[]) => {
      const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
      const places = Array.from({ length: 40 }, (_, i) => ({ name: `남은 클리닉 ${no(i)}`, key: `남은${no(i)}`, url: `https://left${i}.jp/` }));
      listRead(t, "https://excelkospi.ai/mounjaro", "마운자로 병원 목록", places);
      for (const x of extra) listRead(t, x.url, x.title, x.items);
      const { ctx } = cardCtx();
      const rt = t.rowsTool(realArt())!;
      expect(t.takeLateCard("")).toBe(true);
      for (let i = 0; i < 2 && !t.drawn(); i++) await rt.run({ rows: places.slice(0, 38).map((p) => ["도쿄", p.name, "", "", "", p.url, ""]), more: false }, ctx);
      expect(t.drawn()).not.toBeNull();
      return { line: t.cardLine(), count: t.listPlaces(), names: namesOn(lastCard(ctx)).length };
    };
    const prefs = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都 (13442)", "神奈川県", "新潟県"];
    const index = {
      url: "https://md.example.jp/ko/",
      title: "마운자로 온라인 진료 지역별",
      items: [
        ...prefs.map((p, i) => ({ name: p, key: p, url: `https://md.example.jp/prefectures${i}/`, area: p, text: "札幌市 · 札幌市中央区" })),
        ...["인기 순위", "새로 생긴 곳", "이용 안내"].map((n, i) => ({ name: n, key: n, url: `https://md.example.jp/page${i}/`, area: "도쿄" })),
      ],
    };
    // the clinics above the prefectures (mirai's front page, 2026-11-16)
    const clinics = Array.from({ length: 5 }, (_, i) => ({ name: `미라이 클리닉 ${i}`, key: `미라이${i}`, url: `https://md.example.jp/clinic/m${i}/` }));
    const front = { ...index, items: [...clinics, ...index.items] };
    const forum = {
      url: "https://www.clien.example/service/board/park/19292439",
      title: "일본 마운자로(스시자로) 지도 & 최저가 비교사이트를 만들었습니다",
      items: Array.from({ length: 30 }, (_, i) => ({ name: `오늘 올라온 글 ${no(i)} 이야기`, key: `오늘올라온글${no(i)}이야기`, url: `https://www.clien.example/service/board/park/${19292900 + i}`, text: `[${i}]` })),
    };
    const menu = {
      url: "https://osaka-bc.example.jp/menu/mounjaro/",
      title: "マンジャロ | 大美会クリニック",
      items: Array.from({ length: 20 }, (_, i) => ({ name: `リフト施術 ${no(i)}`, key: `リフト施術${no(i)}`, url: `https://osaka-bc.example.jp/menu/m${i}/` })),
    };
    const price = {
      url: "https://private-skin.example.jp/price/",
      title: "料金一覧｜大阪の美容皮膚科",
      items: Array.from({ length: 20 }, (_, i) => ({ name: `ボトックス ${no(i)}`, key: `ボトックス${no(i)}`, url: `https://private-skin.example.jp/menu/b${i}/`, area: "大阪市北区" })),
    };
    // the 38 rows and the list's other 2: no entry of theirs
    for (const x of [index, forum, menu, price]) expect(await lineWith([x])).toEqual({ line: "카드에 40곳 전부 정리했어요.", count: 40, names: 40 });
    expect(await lineWith([index, forum, menu, price])).toEqual({ line: "카드에 40곳 전부 정리했어요.", count: 40, names: 40 });
    // the clinics above the prefectures are places, counted and named; the index's other entries are not
    const cut = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    listRead(cut, front.url, front.title, front.items);
    expect(cut.listPlaces()).toBe(5);
    const front1 = await cutCard(cut, [["도쿄", "미라이 클리닉 0", "", "", "", clinics[0]!.url, ""]]);
    expect(front1.line).toBe("카드에 10곳을 담았어요. 시간 안에 받을 수 있는 만큼만 받아서, 목록 밖에서 찾은 곳 중 일부는 카드에 넣지 못했어요.");
    expect(front1.names.sort()).toEqual([...clinics.map((c) => c.name), ...ROW_PAGES].sort());
    // the same list with places: they count and reach the card; a third of them looking like places is enough
    const fine = { ...menu, title: "오사카 마운자로 클리닉 목록", items: menu.items.map((it) => ({ ...it, name: `${it.name} 클리닉` })) };
    expect(await lineWith([fine])).toEqual({ line: "카드에 60곳 전부 정리했어요.", count: 60, names: 60 });
    const third = { ...menu, title: "오사카 마운자로 모음", items: menu.items.map((it, i) => (i < 7 ? { ...it, name: `${it.name} 클리닉` } : it)) }; // 7 of 20
    expect(await lineWith([third])).toEqual({ line: "카드에 60곳 전부 정리했어요.", count: 60, names: 60 });
  });

  test("전부: a list read again takes no more room; past PLACES_MAX entries the line says the lists' rest is off the card", async () => {
    const no = (i: number) => String(i).padStart(4, "0");
    const lists = Math.ceil(PLACES_MAX / 1000);
    const list = (p: string) => Array.from({ length: 1000 }, (_, i) => ({ name: `${p}${no(i)} 클리닉`, key: `${p}${no(i)}`, url: `https://${p}.example.jp/c/${i}` }));
    const after = async (more: boolean) => {
      const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
      listRead(t, "https://a.example.jp/list", "마운자로 병원 목록", list("a"));
      listRead(t, "https://a.example.jp/list", "마운자로 병원 목록", list("a")); // read again
      for (let i = 1; i < lists; i++) listRead(t, `https://l${i}.example.jp/list`, "마운자로 병원 목록", list(`l${i}`));
      if (more) listRead(t, "https://z.example.jp/list", "마운자로 병원 목록", list("z").slice(0, 8));
      const sent = list("a").slice(0, 5).map((p) => ["도쿄", p.name, "", "", "", p.url, ""]);
      const { line } = await cutCard(t, sent);
      return { line: line!, d: t.drawn()! };
    };
    const kept = await after(false);
    expect(kept.d.rows + kept.d.left.length).toBe(lists * 1000 + ROW_PAGES.length); // each place once, the rows' 5 among them
    expect(kept.line).not.toContain("번째 항목 뒤");
    const full = await after(true);
    expect(full.d.rows + full.d.left.length).toBe(lists * 1000 + ROW_PAGES.length);
    expect(full.line).toContain(` 읽은 목록이 길어서 ${PLACES_MAX.toLocaleString("en-US")}번째 항목 뒤는 카드에 넣지 못했어요.`);
    // bullet lines (no site, no phone: never places) take none of that room, however many
    const b = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    for (let i = 0; i < lists + 1; i++) listRead(b, `https://bullets${i}.example.jp/list`, "마운자로 병원 목록", Array.from({ length: 1000 }, (_, j) => ({ name: `안내 문장 ${no(i * 1000 + j)}`, key: `안내${no(i * 1000 + j)}` })));
    listRead(b, "https://a.example.jp/list", "마운자로 병원 목록", list("a").slice(0, 10));
    const bare = await cutCard(b, []);
    expect(b.drawn()!.rows).toBe(10 + ROW_PAGES.length); // the list's 10 and the rows' own
    expect(bare.line).not.toContain("번째 항목 뒤");
  }, 30_000);

  test("전부: a big round-up never opened is read once before the answer, past the 3/4 rule and the budget; one still unseen is named after it", () => {
    const search = { name: "web_search", explore: "search" } as unknown as ToolDef;
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const t = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    for (let i = 0; i < 4; i++) t.call(search, "web_search", { query: `q${i} 一覧 목록` });
    t.result(search, { ok: true, summary: "", data: { results: [
      { title: "일본 마운자로 병원 593곳", url: "https://excelkospi.ai/mounjaro" },
      { title: "일본 마운자로 클리닉 지도", url: "https://map.example.kr/clinics/" },
      { title: "일본 클리닉 목록 120곳", url: "https://third.example.jp/list/" },
    ] } });
    for (let i = 0; i < 3; i++) {
      t.call(read, "web_read", { url: `https://c${i}.jp/` });
      t.result(read, { ok: true, summary: "", data: { url: `https://c${i}.jp/`, contacts: [{ kind: "kakao", value: `c${i}` }] } });
    }
    expect(t.leadStep(1_000, false)).toBeNull(); // the leads still hold the answer: the search opens them itself
    for (let i = 0; i < 23; i++) t.call(read, "web_read", { url: `https://a${i}.jp/` });
    expect(t.gateMet(1_000)).toBe(true); // 30 calls: released
    // not '전부', or spoken: none
    expect(new ExploreTracker(undefined, 1_000, "text", { text: DENTIST }).leadStep(1_000, true)).toBeNull();
    const v = new ExploreTracker(undefined, 1_000, "voice", { text: ASK_ALL });
    v.call(read, "web_read", { url: "https://c0.jp/" });
    v.result(search, { ok: true, summary: "", data: { results: [{ title: "일본 마운자로 병원 593곳", url: "https://excelkospi.ai/mounjaro" }] } });
    expect(v.leadStep(1_000, true)).toBeNull();
    const step = t.leadStep(1_000, false)!;
    expect(step.only).toBe("web_read");
    expect(step.note).toContain("[정리 사이트 확인]");
    expect(step.note).toContain("https://excelkospi.ai/mounjaro ('일본 마운자로 병원 593곳')");
    expect(step.note).toContain("https://third.example.jp/list/ ('일본 클리닉 목록 120곳')"); // the biggest first
    expect(step.note).not.toContain("map.example.kr"); // two at most
    // the budget spent: the picked reads run past it, others don't
    for (let i = 0; i < 40; i++) t.hold(read, { url: `https://h${i}.jp/` });
    t.call(read, "web_read", { url: "https://excelkospi.ai/mounjaro" });
    t.call(read, "web_read", { url: "https://third.example.jp/list/" });
    t.call(read, "web_read", { url: "https://h99.jp/" });
    expect(t.hold(read, { url: "https://excelkospi.ai/mounjaro" })).toBeNull();
    expect(t.hold(read, { url: "https://third.example.jp/list/" })).toBeNull();
    expect(t.hold(read, { url: "https://h99.jp/" })?.data).toMatchObject({ error: "budget_spent" });
    expect(t.hold(read, { url: "https://excelkospi.ai/mounjaro" })?.data).toMatchObject({ error: "budget_spent" }); // once
    t.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro", title: "병원 593곳", text: "…" } });
    t.result(read, { ok: false, summary: "403", data: { url: "https://third.example.jp/list/", status: 403 } });
    // the second step picks again: the one left (a site found late is read too)
    const again = t.leadStep(1_000, true)!;
    expect(again.note).toContain("https://map.example.kr/clinics/ ('일본 마운자로 클리닉 지도')");
    expect(again.note).not.toContain("excelkospi");
    expect(t.leadStep(1_000, true)).toBeNull(); // two steps at most
    // the one never opened and the one that failed: never 'all'
    expect(t.cardLine()).toBe("아직 안 본 정리 사이트: map.example.kr, third.example.jp.");
    expect(t.cardLine()).toBeNull();
  });

  test("전부 replay (a run that answered '109곳 전부' with a 590-place round-up unopened): the lead step reads it before the answer, outside the steps", async () => {
    const big: ToolDef<{ query: string }> = {
      ...(webSearch as unknown as ToolDef<{ query: string }>),
      run: async (a) => ({ ok: true, summary: "결과", data: { query: a.query, results: a.query === "q1 一覧" ? [{ title: "일본 마운자로 병원 593곳", url: "https://excelkospi.ai/mounjaro" }] : [{ title: a.query, url: `https://${a.query}.example.jp/` }] } }),
    };
    const reads = (n: number, off: number) => Array.from({ length: n }, (_, i) => call(`r${off + i}`, "web_read", { url: `https://p${off + i}.example.jp/` }));
    mock.script.push(
      { toolCalls: ["q1 一覧", "q2 목록", "q3", "q4"].map((q, i) => call(`s${i}`, "web_search", { query: q })) },
      { toolCalls: reads(13, 0) },
      { toolCalls: reads(13, 13) },
      { toolCalls: [call("lead", "web_read", { url: "https://excelkospi.ai/mounjaro" })] },
      { text: ["찾은 곳이에요."] },
    );
    const { outcome } = await run(deepTurn, ASK_ALL, { tools: [big as unknown as ToolDef, webRead as unknown as ToolDef, weather as unknown as ToolDef] });
    expect(mock.requests).toHaveLength(5);
    // 30 calls (3/4): the answer may come, but the round-up was never opened: a step with only the reader, required
    expect((mock.requests[3]!.body.tools ?? []).map((t) => t.function.name)).toEqual(["web_read"]);
    expect(mock.requests[3]!.body.tool_choice).toBe("required");
    expect(lastUser(3)).toContain("[정리 사이트 확인]");
    expect(lastUser(3)).toContain("https://excelkospi.ai/");
    expect(mock.requests[4]!.body.tool_choice).toBe("auto");
    expect(outcome.text).toBe("찾은 곳이에요."); // read: nothing unseen to name
  });

  test("전부: a lead step whose model call fails is skipped (twice at most); the answer comes and the line names the site", async () => {
    const big: ToolDef<{ query: string }> = {
      ...(webSearch as unknown as ToolDef<{ query: string }>),
      run: async (a) => ({ ok: true, summary: "결과", data: { query: a.query, results: a.query === "q1 一覧" ? [{ title: "일본 마운자로 병원 593곳", url: "https://excelkospi.ai/mounjaro" }] : [{ title: a.query, url: `https://${a.query}.example.jp/` }] } }),
    };
    const reads = (n: number, off: number) => Array.from({ length: n }, (_, i) => call(`r${off + i}`, "web_read", { url: `https://p${off + i}.example.jp/` }));
    const down = { status: 500, errorBody: "down" };
    mock.script.push(
      { toolCalls: ["q1 一覧", "q2 목록", "q3", "q4"].map((q, i) => call(`s${i}`, "web_search", { query: q })) },
      { toolCalls: reads(13, 0) },
      { toolCalls: reads(13, 13) },
      down, down, // the lead step (and its one retry)
      down, down, // the second
      { text: ["찾은 곳이에요."] },
    );
    const { outcome } = await run(deepTurn, ASK_ALL, { tools: [big as unknown as ToolDef, webRead as unknown as ToolDef, weather as unknown as ToolDef] });
    expect(mock.requests).toHaveLength(8);
    expect((mock.requests[7]!.body.tools ?? []).map((t) => t.function.name)).toEqual(["web_search", "web_read", "k_weather"]);
    expect(outcome.text).toBe("찾은 곳이에요.\n\n아직 안 본 정리 사이트: excelkospi.ai.");
  });

  test("전부: the search must look for directories in Korean and, abroad, in the place's language (once), and like-search a round-up read (once, Korean first), in steps of their own", () => {
    const search = { name: "web_search", explore: "search", parameters: { type: "object", properties: { query: { type: "string" }, like: { type: "string" } } } } as unknown as ToolDef;
    const plainSearch = { name: "web_search", explore: "search", parameters: { type: "object", properties: { query: { type: "string" } } } } as unknown as ToolDef;
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const items = Array.from({ length: 30 }, (_, i) => ({ name: `C${i}`, key: `c${i}` }));
    const dirs = (x: ExploreTracker) => {
      x.call(search, "web_search", { query: "マンジャロ 一覧" });
      x.call(search, "web_search", { query: "일본 마운자로 가격 비교" });
    };
    const t = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    expect(t.leadStep(1_000, false)).toBeNull(); // nothing searched yet
    t.call(search, "web_search", { query: "마운자로 일본 구매 가능한 곳" });
    const dir = t.leadStep(1_000, false)!;
    expect(dir.only).toBe("web_search");
    expect(dir.note).toContain(
      "[정리 사이트 찾기] 정리 사이트(전체 목록·지도·가격 비교)를 찾는 검색이 아직 모자라요. web_search로 한국어로 목록·정리·비교·지도·성지 같은 낱말을 넣은 질의와 일본어로 一覧·まとめ·比較·ランキング 같은 낱말을 넣은 질의를 한 번씩 불러요",
    );
    // its searches run past the budget: one each
    for (let i = 0; i < 40; i++) t.hold(read, { url: `https://h${i}.jp/` });
    expect(t.hold(search, { query: "マンジャロ 一覧" })).toBeNull();
    expect(t.hold(search, { query: "일본 마운자로 성지 지도" })).toBeNull();
    expect(t.hold(search, { query: "x" })?.data).toMatchObject({ error: "budget_spent" });
    expect(t.leadStep(1_000, false)).toBeNull(); // once
    // one language there: only the other is asked for, with one search past the budget
    const ja = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    ja.call(search, "web_search", { query: "마운자로 일본 목록" }); // Korean words: Japan's own directories are in Japanese
    ja.call(search, "web_search", { query: "mounjaro japan clinic list" }); // English ones too
    const jaStep = ja.leadStep(1_000, false)!.note;
    expect(jaStep).toContain("web_search로 일본어로 一覧·まとめ·比較·ランキング 같은 낱말을 넣은 질의를 한 번씩");
    expect(jaStep).not.toContain("한국어로");
    for (let i = 0; i < 40; i++) ja.hold(read, { url: `https://h${i}.jp/` });
    expect(ja.hold(search, { query: "マンジャロ 一覧" })).toBeNull();
    expect(ja.hold(search, { query: "マンジャロ 比較" })?.data).toMatchObject({ error: "budget_spent" });
    // round-ups read: a like search on one, Korean first (a bigger Japanese one waits), past the budget, once
    t.result(read, { ok: true, summary: "", data: { url: "https://kireihc.jp/column/m/", title: "マンジャロが安いクリニック15院", items: Array.from({ length: 96 }, (_, i) => ({ name: `K${i}`, key: `k${i}` })), itemsTotal: 96 } });
    t.result(read, { ok: true, summary: "", data: { url: "https://care.weblio.jp/mounjaro-online-ko/", title: "일본 마운자로 비대면 진료, 26곳 확인해 보니", text: "…" } });
    t.result(read, { ok: true, summary: "", data: { url: "https://small.jp/list", title: "작은 목록", items: items.slice(0, 12), itemsTotal: 12 } });
    const like = t.leadStep(1_000, false)!;
    expect(like.only).toBe("web_search");
    expect(like.note).toContain(
      "[비슷한 정리 사이트] 지금까지 읽은 정리 목록 https://care.weblio.jp/mounjaro-online-ko/ ('일본 마운자로 비대면 진료, 26곳 확인해 보니', 26곳)과 비슷한 사이트를 찾아요: web_search의 like에 그 주소를 넣어 한 번 불러요.",
    );
    expect(t.hold(search, { like: "https://care.weblio.jp/mounjaro-online-ko/" })).toBeNull(); // past the budget: one
    expect(t.hold(search, { query: "y" })?.data).toMatchObject({ error: "budget_spent" });
    expect(t.leadStep(1_000, false)).toBeNull(); // once
    // no Korean one: the biggest; a price list, a places page and a list under 20 are none
    const jp = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    dirs(jp);
    jp.result(read, { ok: true, summary: "", data: { url: "https://exa.ai/library/places?ids=1", title: "Outdoor Supply Stores in Japan - Exa Places", items, itemsTotal: 43 } });
    jp.result(read, { ok: true, summary: "", data: { url: "https://goto-iin.com/fee/", title: "料金一覧｜大阪市西成区の後藤医院", items, itemsTotal: 135 } });
    jp.result(read, { ok: true, summary: "", data: { url: "https://small.jp/list", title: "작은 목록", items: items.slice(0, 12), itemsTotal: 12 } });
    expect(jp.leadStep(1_000, false)).toBeNull();
    jp.result(read, { ok: true, summary: "", data: { url: "https://aclinic.jp/column/t/", title: "東京でマンジャロが安いクリニック18選", items, itemsTotal: 30 } });
    jp.result(read, { ok: true, summary: "", data: { url: "https://kireihc.jp/column/m/", title: "マンジャロが安いクリニック15院", items: Array.from({ length: 96 }, (_, i) => ({ name: `K${i}`, key: `k${i}` })), itemsTotal: 96 } });
    expect(jp.leadStep(1_000, false)!.note).toContain("지금까지 읽은 정리 목록 https://kireihc.jp/column/m/ ('マンジャロが安いクリニック15院', 96곳)과");
    // done by the model already, a search tool without like: none
    const done = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    dirs(done);
    done.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro", title: "병원 590곳", items, itemsTotal: 590 } });
    done.call(search, "web_search", { like: "https://excelkospi.ai/mounjaro" });
    expect(done.leadStep(1_000, false)).toBeNull();
    const nolike = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    nolike.call(plainSearch, "web_search", { query: "マンジャロ 一覧" });
    nolike.call(plainSearch, "web_search", { query: "일본 마운자로 가격 비교" });
    nolike.result(read, { ok: true, summary: "", data: { url: "https://excelkospi.ai/mounjaro", title: "병원 590곳", items, itemsTotal: 590 } });
    expect(nolike.leadStep(1_000, false)).toBeNull();
    // Korea: Korean only, unless a search went out in another language; Taiwan: its own words
    const kr = new ExploreTracker(undefined, 1_000, "text", { text: "성수동에서 1:1 필라테스 체험 가능한 곳 연락처 전부" });
    kr.call(search, "web_search", { query: "성수동 필라테스" });
    const krNote = kr.leadStep(1_000, false)!.note;
    expect(krNote).toContain("web_search로 한국어로 목록·정리·비교·지도·성지 같은 낱말을 넣은 질의를 한 번씩");
    expect(krNote).not.toContain("그 나라 말로");
    const kr2 = new ExploreTracker(undefined, 1_000, "text", { text: "성수동에서 1:1 필라테스 체험 가능한 곳 연락처 전부" });
    kr2.call(search, "web_search", { query: "성수동 필라테스 가격 비교" });
    expect(kr2.leadStep(1_000, false)).toBeNull();
    const tw = new ExploreTracker(undefined, 1_000, "text", { text: "타이베이 라식 안과 전부 찾아줘" });
    tw.call(search, "web_search", { query: "타이베이 라식 안과 비교" });
    tw.call(search, "web_search", { query: "台北 近視雷射 眼科" });
    expect(tw.leadStep(1_000, false)!.note).toContain("web_search로 그 나라 말로 목록·비교·순위 같은 낱말을 넣은 질의를 한 번씩");
    const tw2 = new ExploreTracker(undefined, 1_000, "text", { text: "타이베이 라식 안과 전부 찾아줘" });
    tw2.call(search, "web_search", { query: "타이베이 라식 안과 비교" });
    tw2.call(search, "web_search", { query: "台北 近視雷射 眼科 懶人包" });
    expect(tw2.leadStep(1_000, false)).toBeNull();
    // not '전부', or spoken: none
    const d = new ExploreTracker(undefined, 1_000, "text", { text: DENTIST });
    d.call(search, "web_search", { query: "치과" });
    expect(d.leadStep(1_000, false)).toBeNull();
    const v = new ExploreTracker(undefined, 1_000, "voice", { text: ASK_ALL });
    v.call(search, "web_search", { query: "마운자로" });
    expect(v.leadStep(1_000, false)).toBeNull();
  });

  test("전부: a list begun and never read to its end is named with how much of it was read; read on to its end, a price list or a menu, or another question, it is not", () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const url = "https://excelkospi.ai/mounjaro";
    const items = Array.from({ length: 749 }, (_, i) => ({ name: `클리닉 ${i}`, key: `c${i}`, url: `https://excelkospi.ai/mounjaro/clinic/c${i}` }));
    const page = (from: number, to: number) => ({ url, title: "일본 마운자로 성지·가격 비교", items: items.slice(from, to), itemsTotal: 749, ...(to < 749 ? { nextItemsFrom: to } : {}) });
    // 1–53 of 749 with the budget spent (2026-11-16): the line said only '아직 안 본 정리 사이트: willclinic.jp.'
    const t = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    t.result(read, { ok: true, summary: "", data: page(0, 53) });
    expect(t.cardLine()).toBe("덜 읽은 정리 사이트: excelkospi.ai(항목 749개 중 53개).");
    const u = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    u.result(read, { ok: true, summary: "", data: page(0, 53) });
    u.result(read, { ok: true, summary: "", data: page(53, 400) });
    u.result(read, { ok: true, summary: "", data: { ...page(400, 520), url: "https://excelkospi.ai/mounjaro/osaka", itemsTotal: 600, nextItemsFrom: 520 } });
    expect(u.cardLine()).toBe("덜 읽은 정리 사이트: excelkospi.ai(항목 749개 중 400개).");
    const w = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    w.result(read, { ok: true, summary: "", data: page(0, 400) });
    w.result(read, { ok: true, summary: "", data: page(400, 749) });
    expect(w.cardLine()).toBeNull();
    // a clinic's price list or menu begun (private-skin's 料金一覧, read to its 138th item as an open list, 2026-11-16):
    // never a list to read on, a lead or named; a list of places begun beside it still is
    const menuAt = "https://private-skin.example.jp/menu/";
    const menu = (from: number) => ({ url: menuAt, title: "施術メニュー｜大阪の美容皮膚科", items: Array.from({ length: 36 }, (_, i) => ({ name: `リフト施術 ${from + i}`, key: `リフト${from + i}`, url: `${menuAt}m${from + i}/` })), itemsTotal: 138, nextItemsFrom: from + 36 });
    const priceAt = "https://private-skin.example.jp/price/";
    for (const data of [{ ...menu(0) }, { ...menu(0), url: priceAt, title: "料金一覧｜大阪の美容皮膚科", items: menu(0).items.map((it) => ({ ...it, name: `${it.name} 클리닉` })) }]) {
      const b = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
      b.result(read, { ok: true, summary: "", data });
      const note = b.note(0, "progress") ?? "";
      expect(note).not.toContain(data.url);
      expect(note).not.toContain("열린 목록부터 끝까지 읽어요");
      expect(b.cardLine()).toBeNull();
      b.result(read, { ok: true, summary: "", data: page(0, 53) });
      expect(b.note(0, "progress")).toContain(`${url} (itemsFrom=53)`);
      expect(b.cardLine()).toBe("덜 읽은 정리 사이트: excelkospi.ai(항목 749개 중 53개).");
    }
    const short = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL }); // too short to be a list
    short.result(read, { ok: true, summary: "", data: { ...page(0, 3), itemsTotal: 5, nextItemsFrom: 3 } });
    expect(short.cardLine()).toBeNull();
    const q = new ExploreTracker(undefined, 1_000, "text", { text: "일본 마운자로 파는 곳 알려줘" });
    q.result(read, { ok: true, summary: "", data: page(0, 53) });
    expect(q.cardLine()).toBeNull();
  });

  test("'전부' over a 시도: a national list's places in other 시도 (or in none, on a national list) are left out, and the line names the wider lists; a list about the 시도, or about none, keeps its places", async () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const ASK = "서울 무료 전시회 전부 카드로 알려줘";
    // 2026-11-17: the '서울 무료 전시회 전부' card held 512 places, 400 of them in 경기, 강원, 부산 … off national lists
    const seoul = ["종로구", "중구", "용산구", "강남구", "관악구", "마포구", "성북구", "서대문구"].map((g, i) => ({ name: `기획전 ${i}`, area: `서울 ${g}` }));
    const elsewhere = [{ name: "기획전 8", area: "경기 성남시" }, { name: "기획전 9", area: "경기 용인시" }, { name: "기획전 10", area: "부산광역시 해운대구" }, { name: "기획전 11", area: "완주" }];
    const national = {
      url: "https://ratilda.com/exhibitions/free/",
      title: "무료 전시회 일정 2026년 11월 · 전국 미술관·갤러리 무료 전시 | 라틸다",
      items: [...seoul, ...elsewhere].map((x, i) => ({ ...x, key: x.name.replace(/\s/g, ""), url: `https://ratilda.com/exhibitions/e-${i}/`, text: `${x.name} · ${x.area} · 관람 무료` })),
      itemsTotal: 12,
    };
    // a city's own site: no 시도 on its entries (and a note on a show elsewhere, with no link: no place)
    const city = {
      url: "https://seoulculturemap.com/",
      title: "서울 문화지도",
      items: [
        ...Array.from({ length: 8 }, (_, i) => ({ name: `문화지도 전시 ${i}`, key: `문화지도전시${i}`, url: `https://museum${i}.example.kr/exhibit`, text: `전시 진행중 · 영등포구` })),
        { name: "순회전 안내", key: "순회전안내", area: "경기 고양시", text: "순회전 안내 · 경기 고양시" },
      ],
      itemsTotal: 9,
    };
    // a list about another 시도: its entries name none, and none is in Seoul
    const busan = {
      url: "https://busanart.example.kr/free/",
      title: "부산 무료 전시 총정리",
      items: Array.from({ length: 8 }, (_, i) => ({ name: `바다 전시 ${i}`, key: `바다전시${i}`, url: `https://gallery${i}.example.kr/`, text: `전시 진행중 · 해운대` })),
      itemsTotal: 8,
    };
    const places = (text: string, pages: Record<string, unknown>[] = [national]) => {
      const t = new ExploreTracker(undefined, 1_000, "text", { text });
      for (const d of pages) t.result(read, { ok: true, summary: "", data: d });
      return t.listPlaces();
    };
    expect(places(ASK)).toBe(8);
    expect(places("무료 전시회 전부 카드로 알려줘")).toBe(12); // no 시도 asked: as before
    expect(places("부산 무료 전시회 전부 카드로 알려줘")).toBe(1);
    expect(places(ASK, [national, city])).toBe(16);
    expect(places(ASK, [busan])).toBe(0);
    expect(places("부산 무료 전시회 전부 카드로 알려줘", [busan, city])).toBe(8);
    const t = new ExploreTracker(undefined, Date.now(), "text", { text: ASK, card: { name: "sys_create_artifact", kind: "html" } });
    for (const d of [national, city, busan]) t.result(read, { ok: true, summary: "", data: d });
    const { ctx, saved } = cardCtx();
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    expect((await rt.run({ rows: [], more: false }, ctx)).ok).toBe(true);
    expect(t.drawn()?.rows).toBe(16);
    expect(saved.map((c) => c.content).join("")).not.toContain("기획전 8");
    expect(t.cardLine()).toBe("카드에 16곳 전부 정리했어요. 다른 지역도 담긴 목록에서는 서울에 있는 곳만 담았어요: ratilda.com(12곳 중 서울 8곳).");
  });

  test("'전부' over a 시·군·구: places another one's address names are left out and the line names the wider lists; a list of the 구 titled with its count holds places; a word like one no address writes scopes nothing", async () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const ASK = "강남구 주차장 전부 알려줘";
    // a Seoul list by address, one call centre's number on every lot ('1544-3113': no place's, it joins none)
    const gus = ["강남구", "강남구", "서초구", "마포구", "강남구", "송파구", "강남구", "강남구", "서초구", "강남구"];
    const seoul = {
      url: "https://parking.example.kr/seoul",
      title: "서울 공영주차장 목록",
      items: gus.map((g, i) => ({ name: `제${i}공영주차장`, key: `제${i}공영주차장`, tel: "1544-3113", area: `서울특별시 ${g}`, url: `https://parking.example.kr/p/${i}`, text: `서울특별시 ${g} 테헤란로 ${i} · 5분 400원` })),
      itemsTotal: 10,
    };
    // the 구's own list: lots by name and fee only, under the kind asked and their count (guidejung's '서울 강남구 주차장 60곳')
    const lots = ["구룡산", "논현로", "대치", "도곡", "삼성로", "세곡", "수서", "신사", "압구정", "역삼로", "일원", "청담"].map((n, i) => `${n}제${i}호`);
    const own = {
      url: "https://parking.guide.example.kr/region/11680",
      title: "서울 강남구 주차장 12곳 · 공영·무료 주차장 요금",
      items: lots.map((n, i) => ({ name: n, key: n, url: `https://parking.guide.example.kr/parking/${i}`, text: "5분 300원 · 추가 5분당 300원" })),
      itemsTotal: 12,
    };
    const places = (text: string, pages: Record<string, unknown>[]) => {
      const t = new ExploreTracker(undefined, 1_000, "text", { text });
      for (const d of pages) t.result(read, { ok: true, summary: "", data: d });
      return t.listPlaces();
    };
    expect(places(ASK, [seoul])).toBe(6);
    expect(places("서울 주차장 전부 알려줘", [seoul])).toBe(10);
    expect(places("친구 만나기 좋은 서울 주차장 전부 알려줘", [seoul])).toBe(10); // a common word, no 구
    expect(places("전시 보러 갈 서울 주차장 전부 알려줘", [seoul])).toBe(10); // no address writes '전시'
    // an address with no 시도 ('강남구 역삼동 …'), and a text that only starts like one ('도시 공원 옆')
    const bare = { ...seoul, title: "서울 주차장 목록", items: seoul.items.map((it, i) => ({ ...it, area: undefined, text: `${gus[i]} ${i % 2 ? "역삼동" : "테헤란로"} ${i} · 5분 400원` })) };
    expect(places(ASK, [bare])).toBe(6);
    expect(places(ASK, [{ ...own, items: own.items.map((it) => ({ ...it, text: "도시 공원 옆 · 5분 300원" })) }])).toBe(12);
    expect(places(ASK, [{ ...own, title: "전국 주차장 12곳 · 공영·무료 주차장 요금" }])).toBe(0); // a national list's, naming no 구
    expect(places(ASK, [{ ...own, title: "서울 강남구 주차장 8곳 · 공영·무료 주차장 요금" }])).toBe(0); // more entries than it names
    // two names with one number are one place; three or more, a shared number
    const twin = { ...seoul, title: "서울 강남구 주차장", items: seoul.items.map((it, i) => ({ ...it, tel: i < 2 ? "02-555-1234" : `02-555-20${i}0` })) };
    expect(places(ASK, [twin])).toBe(5);
    expect(places(ASK, [own])).toBe(12);
    expect(places("강남구 주차장 전부 알려줘", [{ ...own, title: "서울 강남구 주차장 30곳 · 공영·무료 주차장 요금" }])).toBe(0); // a page of a bigger list
    expect(places("강남구 카페 전부 알려줘", [own])).toBe(0); // not the kind asked
    expect(places(ASK, [{ ...own, title: "서울 서초구 주차장 12곳 · 공영·무료 주차장 요금" }])).toBe(0); // another 구's, by its title
    const t = new ExploreTracker(undefined, Date.now(), "text", { text: ASK, card: { name: "sys_create_artifact", kind: "html" } });
    for (const d of [seoul, own]) t.result(read, { ok: true, summary: "", data: d });
    const { ctx, saved } = cardCtx();
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    expect((await rt.run({ rows: [], more: false }, ctx)).ok).toBe(true);
    expect(t.drawn()?.rows).toBe(18);
    expect(saved.map((c) => c.content).join("")).not.toContain("제2공영주차장");
    expect(t.cardLine()).toBe("카드에 18곳 전부 정리했어요. 다른 지역도 담긴 목록에서는 강남구에 있는 곳만 담았어요: parking.example.kr(10곳 중 강남구 6곳).");
  });

  test("'전부' around a spot: lists of the kind asked about a whole 구 are kept off the card and named, with words that ask for them; the spot's and a 동's lists are on it", async () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const ASK = "강남역 근처 주차장 전부 알려줘";
    const list = (url: string, title: string, names: string[], total = names.length) => ({
      url,
      title,
      items: names.map((n, i) => ({ name: n, key: n.replace(/\s/g, ""), url: `${url}/${i}`, text: "5분 400원" })),
      itemsTotal: total,
    });
    const spot = list("https://juchajucha.example.com/place/gangnam", "강남역 주차장 요금 | 주차주차", ["강남교보타워", "리젠메디타워", "천지빌딩", "남영빌딩", "글라스톤빌딩", "ES타워", "대원빌딩", "명성빌딩", "유화빌딩", "808타워"].map((n) => `${n} 주차장`));
    const dong = list("https://dong.example.kr/yeoksam", "서울 강남구 역삼동 주차장 모음", Array.from({ length: 8 }, (_, i) => `역삼 ${i}번 주차장`));
    // 2026-11-17: guidejung's 60 lots of all 강남구 and junkangworld's chips under '강남구 주차장 58곳' were hidden
    const lots = ["구룡산", "논현로", "대치", "도곡", "삼성로", "세곡", "수서", "신사", "압구정", "역삼로", "일원", "청담"].map((n, i) => `${n}제${i}호`);
    // its first page read: the card reads none of the rest, and it is not named as read in part
    const own = { ...list("https://parking.guide.example.kr/region/11680", "서울 강남구 주차장 60곳 · 공영·무료 주차장 요금", lots, 60), nextItemsFrom: 12 };
    const chips = ["08:00 ~ 19:00", "부설 주차장", "전화가능", "상세정보 보기"];
    const chipPage = {
      url: "https://junkangworld.example.com/parking/32200",
      title: "서울특별시 강남구 주차장 58곳 완벽정리 - 무료/24시간 주차장, 요금 비교",
      items: Array.from({ length: 12 }, (_, i) => ({ name: chips[i % 4]!, key: `${chips[i % 4]}${i}`, url: `https://junkangworld.example.com/parking/32200/lot-${Math.floor(i / 4)}` })),
      itemsTotal: 71,
    };
    // a 구's list with no count in its title: the entries it lists (parking.3minhealth.com's 32, its first 10 read)
    const day = {
      url: "https://parking.day.example.kr/seoul/gangnam-gu/24h/",
      title: "서울 강남구 24시간 주차장 | 요금·운영시간",
      items: Array.from({ length: 10 }, (_, i) => ({ name: `개포${i}공원`, key: `개포${i}공원`, tel: "1544-3113", area: "서울특별시 강남구", url: `https://parking.day.example.kr/seoul/gangnam-gu/p${i}/` })),
      itemsTotal: 14,
      nextItemsFrom: 10,
    };
    const t = new ExploreTracker(undefined, Date.now(), "text", { text: ASK, card: { name: "sys_create_artifact", kind: "html" } });
    for (const d of [spot, own, { ...chipPage, itemsCut: true }, day, dong]) t.result(read, { ok: true, summary: "", data: d });
    expect(t.listPlaces()).toBe(18);
    const { ctx, saved } = cardCtx();
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    expect((await rt.run({ rows: [], more: false }, ctx)).ok).toBe(true);
    expect(t.drawn()?.rows).toBe(18);
    expect(saved.map((c) => c.content).join("")).not.toContain("구룡산제0호");
    expect(t.cardLine()).toBe(
      "카드에 18곳을 담았어요. 강남구 전체 목록은 카드에 넣지 않았어요: parking.guide.example.kr(60곳), junkangworld.example.com(58곳), parking.day.example.kr(14곳).\n강남구 전체를 보시려면 '강남구 주차장 전부 보여줘'라고 말씀해 주세요.",
    );
    // the words asked with are a search for places; no spot asked about, the 구's list is on the card
    expect([exploreIntent("강남구 주차장 전부 보여줘"), exploreOpen("강남구 주차장 전부 보여줘")]).toEqual([true, false]);
    const whole = new ExploreTracker(undefined, 1_000, "text", { text: "강남구 주차장 전부 보여줘" });
    for (const d of [spot, own, chipPage, dong]) whole.result(read, { ok: true, summary: "", data: d });
    expect(whole.listPlaces()).toBe(30);
    // a list about the spot, or a 시도's list of another kind, stays as it was
    const other = new ExploreTracker(undefined, 1_000, "text", { text: ASK });
    for (const d of [spot, { ...own, title: "서울 강남구 강남역 주차장 60곳" }, { ...dong, url: "https://cafe.example.kr/x", title: "서울 강남구 카페 모음" }]) other.result(read, { ok: true, summary: "", data: d });
    expect(other.listPlaces()).toBe(30); // 10 + 12 + the 8 lots under a title of another kind, all on the card
    expect(other.cardLine()).toBe("덜 읽은 정리 사이트: parking.guide.example.kr(항목 60개 중 12개)."); // the spot's own list, read in part
    // a site's front page under a 시도's title: its menu holds no lots and names no region; a 구's list of 8 lots in 24
    // rows (kind, fee, entrance: seoulparking.com 2026-11-17, '강남구·서울 … seoulparking.com(24곳)') names its 8
    const sp = "https://seoulparking.example.com";
    const menu = [["최근 확인한 목적지", "/regions/"], ["사진으로 둘러보는 목적지", "/regions/"], ["목적지 주차장 전체 목록", "/places/jamwon/"], ["주차요금 비교", "/rankings/"], ["새로 올라온 가이드", "/guides/"], ["숫자는 공식 자료로, 모르는 건 모른다고", "/about/"], ["지역별로 찾기", "/regions/seoul/"], ["자주 묻는 질문", ""]];
    const front = { url: `${sp}/`, title: "서울·수도권 주차장 정보와 주차 꿀팁 | 파인더주차장", items: menu.map(([n, at]) => ({ name: n!, key: n!, ...(at ? { url: `${sp}${at}` } : {}) })), itemsTotal: menu.length };
    const rows = ["공영주차장 / 강남구도시관리공단", "1시간 3,600원 24시간", "입구, 높이: 확인 못 함"];
    const three = { url: `${sp}/regions/seoul/gangnam-gu/`, title: "강남구 주차장 8곳 요금 비교와 명소별 가이드 | 파인더주차장", items: Array.from({ length: 24 }, (_, i) => ({ name: `${rows[i % 3]}${i % 3 === 1 ? ` ${100 + i}면` : ""}`, key: `r${i}`, url: `${sp}/parking/lot-${Math.floor(i / 3)}/` })), itemsTotal: 24 };
    const site = new ExploreTracker(undefined, 1_000, "text", { text: ASK });
    for (const d of [spot, own, front, three]) site.result(read, { ok: true, summary: "", data: d });
    expect(site.listPlaces()).toBe(10);
    expect(site.cardLine()).toBe(
      "강남구 전체 목록은 카드에 넣지 않았어요: parking.guide.example.kr(60곳), seoulparking.example.com(8곳).\n강남구 전체를 보시려면 '강남구 주차장 전부 보여줘'라고 말씀해 주세요.",
    );
    // a lot's own page under its 구 (a name before the kind: rainygenius, bluesquare by 강남역, 2026-11-17): on the card; a
    // 구's list of kinds, or one plain word before the kind: the 구's, named with its lots (17 of a list of 30 read whole)
    // or the entries of one read in part (12 of 58)
    const lotsOf = (url: string, title: string, tag: string, total?: number) => list(url, title, Array.from({ length: 10 }, (_, i) => `${tag}${i}빌딩 주차장`), total);
    const lotPage = lotsOf("https://parking.rain.example.com/yeoksam-1", "서울 강남구 역삼문화공원 제1호 공영주차장 노외주차장 주차요금", "역삼");
    const hotel = lotsOf("https://bluesquare.example.app/parking/58991", "서울 강남구 강남대로94길 648호텔 주차장 총정리", "서초");
    const kinds = {
      url: "https://dongne.example.kr/region/seoul-gangnam",
      title: "서울 강남구 공중화장실·공영주차장·전기차 충전소 | 동네맵",
      items: [
        ...Array.from({ length: 17 }, (_, i) => ({ name: `도곡${i}빌딩 주차장`, key: `도곡${i}`, url: `https://dongne.example.kr/p/${i}` })),
        ...Array.from({ length: 13 }, (_, i) => ({ name: `개포${i} 공중화장실`, key: `개포${i}` })),
      ],
      itemsTotal: 30,
    };
    const cheap = lotsOf("https://parkmap.example.kr/seoul/gangnam", "서울 강남구 저렴한 주차장 · 주차 요금", "논현", 58);
    const named = new ExploreTracker(undefined, 1_000, "text", { text: ASK });
    for (const d of [spot, lotPage, hotel, kinds, cheap]) named.result(read, { ok: true, summary: "", data: d });
    expect(named.listPlaces()).toBe(30);
    expect(named.cardLine()).toBe(
      "강남구 전체 목록은 카드에 넣지 않았어요: dongne.example.kr(17곳), parkmap.example.kr(58곳).\n강남구 전체를 보시려면 '강남구 주차장 전부 보여줘'라고 말씀해 주세요.",
    );
    // the spot, or a 동, later in a 구's title: that list is about it, on the card
    for (const title of ["서울 강남구 주차장 60곳 – 강남역 일대", "서울 강남구 주차장 · 역삼동 60곳"]) {
      const c = new ExploreTracker(undefined, 1_000, "text", { text: ASK });
      c.result(read, { ok: true, summary: "", data: { ...own, title } });
      expect([title, c.listPlaces()]).toEqual([title, 12]);
    }
    // the common kinds of place no ending tells (lead 2026-11-17: '식당', '약국', '카페', '센터', '학원', '공원', '병원'): a 구's
    // list of them is the 구's, as for '주차장'; a '…원' of people ('회원', '직원', '국회의원') is no kind of place
    // (each entry with its phone: places by any noun)
    const kindList = (noun: string) => ({ ...own, title: `서울 강남구 ${noun} 60곳 · 위치`, items: own.items.map((it, i) => ({ ...it, tel: `02-555-${1000 + i}` })) });
    for (const noun of ["식당", "약국", "카페", "주민센터", "학원", "공원", "동물병원", "한의원", "치과", "마트"]) {
      const c = new ExploreTracker(undefined, 1_000, "text", { text: `강남역 근처 ${noun} 전부 알려줘` });
      c.result(read, { ok: true, summary: "", data: kindList(noun) });
      expect([noun, c.listPlaces()]).toEqual([noun, 0]);
    }
    for (const noun of ["회원", "직원", "국회의원"]) {
      const c = new ExploreTracker(undefined, 1_000, "text", { text: `강남역 근처 ${noun} 전부 알려줘` });
      c.result(read, { ok: true, summary: "", data: kindList(noun) });
      expect([noun, c.listPlaces()]).toEqual([noun, 12]);
    }
    // a spot no word shape tells (코엑스), and a title's first word no address writes ('전시'): on the card
    for (const title of ["서울 강남구 코엑스 주차장 60곳", "서울 강남구 주차장 60곳 – 코엑스 일대", "전시 관람객 주차장 60곳 안내", "전시 주차장 60곳 안내"]) {
      const c = new ExploreTracker(undefined, 1_000, "text", { text: "코엑스 근처 주차장 전부 알려줘" });
      c.result(read, { ok: true, summary: "", data: { ...own, title } });
      expect([title, c.listPlaces()]).toEqual([title, 12]);
    }
  });

  test("'전부' over a noun no clinic word names: entries naming it (past a type word) are places; a site menu, an index of areas, a clinic question are as before", () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const PARK = "강남역 근처 주차장 전부 알려줘";
    // 2026-11-17: 블루스퀘어's 51 lots and 주차주차's 10 were read in full and set aside (no clinic word), and the card said '56곳 전부'
    const at = "https://bluesquare.app/parking/place/교보타워/";
    const lots = ["강남교보타워", "리젠메디타워", "천지빌딩", "남영빌딩", "글라스톤빌딩", "ES타워", "대원빌딩", "명성빌딩", "유화빌딩", "808타워"];
    const items = lots.map((n, i) => ({ name: `${n} 주차장`, key: `${n}주차장`, url: `https://bluesquare.app/parking/${5000 + i}/`, text: `${i * 50}m, 1분 · 30분 3000원` }));
    const data = { url: at, title: "교보타워 주차장 88곳 요금, 거리 비교 - 블루스퀘어 주차", items, itemsTotal: items.length };
    const places = (text: string, d: Record<string, unknown> = data) => {
      const t = new ExploreTracker(undefined, 1_000, "text", { text });
      t.result(read, { ok: true, summary: "", data: d });
      return t.listPlaces();
    };
    expect(places(PARK)).toBe(lots.length);
    expect(places("강남역 근처 카페 전부 알려줘")).toBe(0); // the lots are not what was asked: set aside as before
    // a noun that is no kind of place: its name in entries proves nothing (a filings list's '…공시' rows on its own site)
    const filings = { url: "https://stock.example.kr/005930", title: "삼성전자 공시 목록", items: ["기업설명회(IR)개최(안내공시)", "장래사업ㆍ경영계획(공정공시)", "기타경영사항(자율공시)", "대규모기업집단현황공시", "수시공시의무관련사항(공정공시)", "연결재무제표기준영업(잠정)실적(공정공시)", "자기주식취득결과보고서", "분기보고서", "현금ㆍ현물배당결정", "주식등의대량보유상황보고서"].map((n, i) => ({ name: n, key: `${i}${n}`, url: `https://stock.example.kr/005930/d/${i}` })), itemsTotal: 10 };
    expect(places("삼성전자 공시 전부 찾아줘", filings)).toBe(0);
    // a site's menu or an index of areas under a parking title holds no lots
    const menu = { url: "https://www.gangnam.go.kr/board/view.do", title: "공영주차장 현황 | 강남구청", items: ["종합민원", "민원신고", "분야별민원", "민원신청·서비스", "여권민원", "정보공개", "구정소식", "강남소개", "열린구청장실", "참여마당"].map((n, i) => ({ name: n, key: n, url: `https://www.gangnam.go.kr/contents/${i}/view.do` })), itemsTotal: 103, nextItemsFrom: 10 };
    expect(places(PARK, menu)).toBe(0);
    // a menu naming the kind in its links ('목적지 주차장 전체 목록', '주차요금 비교', '주차 꿀팁'): no lots; a lot named with
    // the noun's own ending, a number after it, or the noun alone as a word, is one
    // (asked over a 구: around a spot the page is a 시도's list, kept off the card either way)
    const sp = "https://seoulparking.example.com";
    const links = [["최근 확인한 목적지", "/regions/"], ["사진으로 둘러보는 목적지", "/regions/"], ["목적지 주차장 전체 목록", "/places/jamwon/"], ["주차요금 비교", "/rankings/"], ["새로 올라온 가이드", "/guides/"], ["숫자는 공식 자료로, 모르는 건 모른다고", "/about/"], ["지역별로 찾기", "/regions/seoul/"], ["자주 묻는 질문", ""]];
    const front = { url: `${sp}/`, title: "서울·수도권 주차장 정보와 주차 꿀팁 | 파인더주차장", items: links.map(([n, at]) => ({ name: n!, key: n!, ...(at ? { url: `${sp}${at}` } : {}) })), itemsTotal: links.length };
    expect(places("강남구 주차장 전부 보여줘", front)).toBe(0); // 5 before: every link but the two to one page
    const tips = ["강남 주차 꿀팁", "공영주차장 순위", "역삼 주차장 모음", "주차장 검색", "주차권 리스트", "주차요금 안내", "지역별로 찾기", "자주 묻는 질문"];
    expect(places("강남구 주차장 전부 보여줘", { ...front, items: tips.map((n, i) => ({ name: n, key: n, url: `${sp}/t${i}/` })), itemsTotal: tips.length })).toBe(0);
    // each list word alone, and the stem inside another noun ('주차요금', '주차권'): no lots
    const towns = ["강남", "역삼", "서초", "논현", "삼성", "청담", "신사", "대치"];
    const menuOf = (names: string[]) => ({ ...front, items: names.map((n, i) => ({ name: n, key: n, url: `${sp}/w${i}/` })), itemsTotal: names.length });
    for (const w of ["목록", "리스트", "모음", "총정리", "비교", "가이드", "꿀팁", "순위", "랭킹", "찾기", "검색", "자주 묻는"])
      expect([w, places("강남구 주차장 전부 보여줘", menuOf(towns.map((a) => `${a} 주차장 ${w}`)))]).toEqual([w, 0]);
    expect(places("강남구 주차장 전부 보여줘", menuOf(["주차요금 안내", "주차권 구매", "주차단속 정보", "주차위반 신고", "주차공간 공유", "주차면 현황", "주차정기권 신청", "주차할인 안내"]))).toBe(0);
    expect(places("강남구 주차장 전부 보여줘", menuOf(towns.map((a) => `${a}빌딩 주차장`)))).toBe(8); // the same page of lots
    const named = ["교보타워 주차장(민영)", "메리츠타워 부설주차장33m", "역삼 1호 주차 빌딩", "강남 공영주차장", ...lots.slice(0, 4).map((n) => `${n} 주차장`)];
    expect(places(PARK, { ...data, items: named.map((n, i) => ({ name: n, key: n, url: `https://bluesquare.app/parking/${7000 + i}/`, text: "30분 3000원" })), itemsTotal: named.length })).toBe(named.length);
    const areas = { url: "https://app.modu.kr/places", title: "지역별 주차장·주차권 가격 비교 | 모두의주차장", items: ["강남역", "코엑스", "선릉역", "신사역", "역삼역", "삼성역", "교대역", "양재역", "논현역", "압구정역"].map((n, i) => ({ name: n, key: n, url: `https://app.modu.kr/places/a${i}` })), itemsTotal: 184, nextItemsFrom: 10 };
    expect(places(PARK, areas)).toBe(0);
    // a lot page's chips (junkangworld's 71 items under '강남구 주차장 58곳'): a type word alone ('부설 주차장') is no lot
    const chips = ["08:00 ~ 19:00", "부설 주차장", "전화가능", "상세정보 보기", "24시간", "노상 주차장", "공영 주차장", "무료", "유료", "노외 주차장", "주말 운영", "평일 운영"];
    const chipPage = { url: "https://junkangworld.com/parking/32200", title: "서울특별시 강남구 주차장 58곳 완벽정리", items: chips.map((n, i) => ({ name: n, key: `${n}${i}`, url: `https://junkangworld.com/parking/32200/${i}` })), itemsTotal: chips.length };
    expect(places(PARK, chipPage)).toBe(0);
    const line = new ExploreTracker(undefined, 1_000, "text", { text: PARK });
    line.result(read, { ok: true, summary: "", data: areas });
    expect(line.cardLine()).toBeNull(); // not a list of lots: never named as read in part
  });

  test("전부: a list whose title names many times its places is one page of a bigger directory: its site's other pages are a lead, and the line says so", () => {
    const search = { name: "web_search", explore: "search" } as unknown as ToolDef;
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    // its front page: 6 clinics (linking their prefecture's page and their own site) over 15 prefectures (2026-11-16)
    const mirai = (p: number) => `https://md.mirai-medical.clinic/prefectures${String(p).padStart(2, "0")}/`;
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({ name: `미라이 클리닉 ${i}`, key: `미라이${i}`, url: mirai(i + 20), links: [{ url: `https://c${i}.example.jp/` }] })),
      ...["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県"].map((n, i) => ({ name: n, key: n, url: mirai(i + 1) })),
    ];
    const t = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    for (let i = 0; i < 4; i++) t.call(search, "web_search", { query: `q${i} 一覧 목록` });
    for (let i = 0; i < 3; i++) {
      t.call(read, "web_read", { url: `https://c${i}.jp/` });
      t.result(read, { ok: true, summary: "", data: { url: `https://c${i}.jp/`, contacts: [{ kind: "kakao", value: `c${i}` }] } });
    }
    for (let i = 0; i < 14; i++) t.call(read, "web_read", { url: `https://a${i}.jp/` });
    expect(t.gateMet(1_000)).toBe(true);
    const url = "https://md.mirai-medical.clinic/";
    t.call(read, "web_read", { url });
    t.result(read, { ok: true, summary: "", data: { url, title: "全国のマンジャロが安いおすすめクリニック一覧665院", items, itemsTotal: 21 } });
    expect(t.gateMet(1_000)).toBe(false);
    expect(t.note(1_000, "progress")).toContain(`목록이 잘린 페이지: ${url} (제목은 665곳, 이 페이지 항목은 21개). 더 있는 목록이에요`);
    // the places counted on it as the card counts them: its 6 clinics, never the 15 prefectures
    expect(t.cardLine()).toBe("덜 읽은 정리 사이트: md.mirai-medical.clinic(665곳 중 6곳).");
    // one of its other pages read: done
    const u = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    u.result(read, { ok: true, summary: "", data: { url, title: "一覧665院", items, itemsTotal: 21 } });
    u.result(read, { ok: true, summary: "", data: { url: "https://md.mirai-medical.clinic/osaka/", title: "大阪 一覧85院", items: Array.from({ length: 85 }, (_, i) => ({ name: `O${i}`, key: `o${i}` })), itemsTotal: 85 } });
    expect(u.cardLine()).toBeNull();
    // a title near its list (60 of 21), or a page with no list: not one
    for (const data of [{ url, title: "一覧60院", items, itemsTotal: 21 }, { url, title: "一覧665院", text: "…" }]) {
      const n = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
      n.result(read, { ok: true, summary: "", data });
      expect(n.cardLine()).toBeNull();
    }
  });

  test("전부: text read on is outside the budget only on a list or directory page (a pick of eight is counted)", () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const t = new ExploreTracker(undefined, 1_000, "text", { text: ASK_ALL });
    const pages = [
      ["https://pick.jp/8", "マンジャロおすすめ8選", 1],
      ["https://dir.jp/", "마운자로 병원 지도", 0],
      ["https://big.jp/", "마운자로 클리닉 120곳 비교", 0],
      ["https://guide.jp/clinics/", "マンジャロ", 0],
      ["https://blog.jp/column/mounjaro/", "マンジャロ 通販 おすすめ 10選 比較", 1],
    ] as const;
    let calls = 0;
    for (const [url, title, counted] of pages) {
      t.call(read, "web_read", { url });
      t.result(read, { ok: true, summary: "", data: { url, title, text: "…", nextFrom: 4000 } });
      t.call(read, "web_read", { url, from: 4000 });
      calls += 1 + counted;
      expect(t.summary().calls).toBe(calls);
    }
    // the items of a list read on: always outside (a list with no total given too)
    t.call(read, "web_read", { url: "https://plain.jp/" });
    t.result(read, { ok: true, summary: "", data: { url: "https://plain.jp/", title: "マンジャロ", items: [{ name: "A", key: "a" }], nextItemsFrom: 1 } });
    t.call(read, "web_read", { url: "https://plain.jp/", itemsFrom: 1 });
    expect(t.summary().calls).toBe(calls + 1);
  });

  test("전부 in the loop: no directory search after the first step → a search step for them; a round-up read → a like-search step; both outside the steps", async () => {
    const likeSearch: ToolDef<{ query?: string; like?: string }> = {
      ...(webSearch as unknown as ToolDef<{ query?: string; like?: string }>),
      parameters: { type: "object", properties: { query: { type: "string" }, like: { type: "string" } } },
      run: async (a) => ({ ok: true, summary: "결과", data: { query: a.query ?? "", ...(a.like ? { like: a.like } : {}), results: [{ title: `r ${a.query ?? a.like}`, url: `https://r${searched.push("x")}.example.jp/` }] } }),
    };
    const listRead: ToolDef<{ url: string }> = {
      ...(webRead as unknown as ToolDef<{ url: string }>),
      run: async (a) => ({ ok: true, summary: "읽었어요", data: { url: a.url, title: "병원 590곳", items: Array.from({ length: 30 }, (_, i) => ({ name: `C${i}`, key: `c${i}`, url: `https://c${i}.jp/` })), itemsTotal: 590, nextItemsFrom: 30 } }),
    };
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "マンジャロ 購入" }), call("b", "web_search", { query: "마운자로 일본" })] },
      { toolCalls: [call("c", "web_search", { query: "マンジャロ クリニック 一覧" }), call("c2", "web_search", { query: "일본 마운자로 성지 지도" })] },
      { toolCalls: [call("d", "web_read", { url: "https://excelkospi.ai/mounjaro" })] },
      { toolCalls: [call("e", "web_search", { like: "https://excelkospi.ai/mounjaro" })] },
      { text: ["찾은 곳이에요."] },
    );
    await run(deepTurn, ASK_ALL, { tools: [likeSearch as unknown as ToolDef, listRead as unknown as ToolDef, weather as unknown as ToolDef] });
    const names = (i: number) => (mock.requests[i]!.body.tools ?? []).map((t) => t.function.name);
    expect(names(1)).toEqual(["web_search"]);
    expect(mock.requests[1]!.body.tool_choice).toBe("required");
    expect(lastUser(1)).toContain("[정리 사이트 찾기]");
    expect(names(2)).toEqual(["web_search", "web_read", "k_weather"]);
    expect(names(3)).toEqual(["web_search"]);
    expect(lastUser(3)).toContain("[비슷한 정리 사이트] 지금까지 읽은 정리 목록 https://excelkospi.ai/mounjaro ('병원 590곳', 590곳)과");
    expect(names(4)).toEqual(["web_search", "web_read", "k_weather"]);
    // outside the steps: the next search step is the third ('질의 5개', the like search one of them)
    expect(lastUser(4)).toContain("[찾기 진행] 질의 5개");
  });

  test("voice '전부': no card_rows and no card (not offered; called anyway, not run); no card line after it", async () => {
    const spoken = "스시자로가 있어요. 카톡으로 주문받아요. 몇 곳 더 있어요.";
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("r", "web_read", { url: "https://xn--2o2b11q2e68p.site/" }), call("own", "sys_create_artifact", { title: "목록", kind: "html", content: "<ul><li>스시자로</li></ul>" })] },
      { text: [spoken] },
    );
    const { ctx, saved } = cardCtx();
    (ctx as { mode?: string }).mode = "voice";
    const { outcome } = await run(deepTurn, `${ASK_ALL} 카드로`, { tools: [...TOOLS, realArt()], ctx, mode: "voice" });
    expect(mock.requests).toHaveLength(3);
    for (const r of mock.requests) expect((r.body.tools ?? []).map((t) => t.function.name)).not.toContain("card_rows");
    for (const r of mock.requests) expect((r.body.tools ?? []).map((t) => t.function.name)).not.toContain("sys_create_artifact"); // no card in voice
    const back = String(mock.requests[2]!.body.messages.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "own")!.content);
    expect(back).toContain("not_in_this_turn");
    expect(saved).toHaveLength(0);
    expect(outcome.text.startsWith(VOICE_SEARCH_PREFACE)).toBe(true);
    expect(outcome.text.endsWith(spoken)).toBe(true);
    expect(outcome.text).not.toContain("카드");
  });

  test("rows card refused because the answer has its card already (one per answer): kept, no second try, no line", async () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    const { ctx, saved } = cardCtx();
    expect((await realArt().run({ title: "먼저", kind: "html", content: "<p>먼저 만든 카드</p>" }, ctx)).ok).toBe(true);
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    const r = await rt.run({ rows: Array.from({ length: 12 }, (_, i) => ["도쿄", `클리닉 ${i}`, "", "", "", `https://c${i}.clinic.jp/`, ""]), more: false }, ctx);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toContain("one_per_answer");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.title).toBe("먼저");
    expect(t.rowsPending()).toBe(false);
    expect(t.cardLine()).toBeNull();
  });

  test("rows card: the answer streams first, '카드 만드는 중' after it; a card step that fails (the model) leaves the answer and says so", async () => {
    const artifact: ToolDef = {
      name: "sys_create_artifact",
      description: "Save an artifact",
      parameters: { type: "object", properties: { kind: { type: "string", enum: ["html"] }, content: { type: "string" } } },
      icon: "doc",
      title: () => "화면 만드는 중",
      run: async () => ({ ok: true, summary: "화면을 만들었어요" }),
    };
    const wide = createRunTurn(llm, { deepSearch: { exhaustive: { calls: 20, minQueries: 3, minCalls: 0 } } });
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("r", "web_read", { url: "https://q1.example.jp/" })] },
      { text: ["목록은 이어서 카드로 보여 드려요."] },
      { status: 400, errorBody: "bad request" },
    );
    const { events, outcome } = await run(wide, "도쿄·오사카 피부과 20곳 가격순 카드로", { tools: [...TOOLS, artifact] });
    const textAt = events.findIndex((e) => e.type === "text");
    const cardAt = events.findIndex((e) => e.type === "status" && e.text === CARD_STATUS);
    expect(textAt).toBeGreaterThan(-1);
    expect(cardAt).toBeGreaterThan(textAt); // after the answer's first words
    expect(mock.requests).toHaveLength(4);
    expect(outcome.text).toBe("목록은 이어서 카드로 보여 드려요.\n\n카드는 만들지 못했어요. 전체 목록이 필요하시면 한 번 더 말씀해 주세요.");
  });

  test("rows card: rows far fewer than asked go back once, with why; then the rest comes and the card has them all", async () => {
    const artifact = realArt();
    const row = (i: number) => ["도쿄", `C${i}`, "", "", "", `https://c${i}.clinic.jp/`, "정리 사이트"];
    const wide = createRunTurn(llm, { deepSearch: { exhaustive: { calls: 20, minQueries: 3, minCalls: 0 } } });
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("r", "web_read", { url: "https://q1.example.jp/" })] },
      { text: ["도쿄 피부과를 찾았어요. 전체는 카드로 보여 드려요."] },
      { toolCalls: [call("art", "card_rows", { title: "목록", rows: Array.from({ length: 10 }, (_, i) => row(i)), more: false })] },
      { toolCalls: [call("art2", "card_rows", { rows: Array.from({ length: 12 }, (_, i) => row(10 + i)), more: false })] },
    );
    const { ctx, saved } = cardCtx();
    const { events, outcome } = await run(wide, "도쿄·오사카 피부과 20곳 가격순 카드로", { tools: [...TOOLS, artifact], ctx });
    expect(mock.requests).toHaveLength(5);
    expect(lastUser(3)).toContain("요청한 수가 20곳이에요. 그곳들을 하나도 빼지 않고");
    const back = String(mock.requests[4]!.body.messages.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "art")!.content);
    expect(back).toContain("card_too_short");
    expect(back).toContain("지금 10곳이에요. 요청한 수가 20곳이에요.");
    expect(events.some((e) => e.type === "tool" && e.tool.summary === "목록을 더 채우는 중")).toBe(true);
    expect(saved).toHaveLength(1);
    expect((saved[0]!.content.match(/<li>/g) ?? []).length).toBe(22);
    expect(saved[0]!.content).toContain(nw("<b>22곳</b>"));
    expect(outcome.text).toBe("도쿄 피부과를 찾았어요. 전체는 카드로 보여 드려요.\n\n카드에 22곳 전부 정리했어요.");
    // a model-written html card is still held to the count as before
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    const art = { name: "sys_create_artifact" } as unknown as ToolDef;
    expect(t.hold(art, { kind: "html", content: "<ul><li>A</li></ul>" })).toBeNull(); // no count to hold it to
  });

  test("rows card: the same page under two names is one row (same amount, or one name inside the other); a round-up page linked for many places and a chain's one page for other areas keep them all", async () => {
    const t = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    let saved = "";
    const real = { name: "sys_create_artifact", run: async (a: { content: string }) => ((saved = a.content), { ok: true, summary: "" }) } as unknown as ToolDef;
    const tool = t.rowsTool(real)!;
    await tool.run(
      {
        rows: [
          ["도쿄", "신주쿠 동쪽출구 프라이머리케어 클리닉", "신주쿠역 도보 3분", "2.5mg 2주 ¥8,000", "", "https://shinjuku.clinic/", "정리 사이트"],
          ["도쿄", "신주쿠 히가시구치 프라이머리케어 클리닉", "신주쿠역 도보 3분", "2.5mg 2주 1상자 ¥8,000", "", "https://shinjuku.clinic/#a", "정리 사이트"],
          ["도쿄", "이스트 클리닉 신주쿠", "신주쿠", "¥19,200", "", "https://east.jp/", "정리 사이트"],
          ["오사카", "이스트 클리닉 우메다", "우메다", "¥19,200", "", "https://east.jp/", "정리 사이트"],
          ["도쿄", "도쿄 실크 클리닉 간다원", "", "¥8,000", "", "https://silk.jp/", "정리 사이트"],
          ["도쿄", "도쿄 실크 클리닉(빌라 대표)", "간다역", "¥8,000", "", "https://silk.jp/", "검색 요약"],
          // one round-up page as the link of three online clinics (aitoolog, run 2): three places
          ["온라인", "미테네 콜닥터", "온라인", "¥18,700", "", "https://aitoolog.com/online/", "정리 사이트"],
          ["온라인", "스마루나", "온라인", "¥22,000", "", "https://aitoolog.com/online/", "정리 사이트"],
          ["온라인", "키레이패스", "온라인", "상담 후 결정", "", "https://aitoolog.com/online/", "정리 사이트"], // a price without an amount
          ["온라인", "SSC 뷰티 클리닉", "온라인", "¥22,000", "", "https://aitoolog.com/online/", "정리 사이트"], // スマルナ's price, another place
          // a page with two places on it: the same name with other brackets is the one place (amounts aside)
          ["도쿄", "신주쿠역앞 클리닉", "신주쿠", "¥3,500", "", "https://ekimae.jp/", "정리 사이트"],
          ["도쿄", "신주쿠에키마에 클리닉(피부과·내과)", "신주쿠", "¥14,000", "", "https://ekimae.jp/", "정리 사이트"],
          ["도쿄", "신주쿠 에키마에 클리닉(헬스)", "신주쿠", "¥15,000", "", "https://ekimae.jp/", "정리 사이트"],
          // one name inside the other on one page, the prices apart (a single pen and a set): one place
          ["온라인", "이스트 역앞 (온라인)", "", "¥9,000", "", "https://east-ekimae.jp/", "정리 사이트"],
          ["온라인", "이스트 역앞 (온라인 단품)", "", "¥2,600", "", "https://east-ekimae.jp/", "정리 사이트"],
        ],
        more: false,
      },
      fakeCtx(),
    );
    expect((saved.match(/<li>/g) ?? []).length).toBe(11);
    expect(saved).not.toContain("(헬스)");
    expect(saved).not.toContain("히가시구치");
    expect(saved).toContain("이스트 클리닉 우메다");
    expect(saved).not.toContain("빌라 대표");
    for (const n of ["미테네 콜닥터", "스마루나", "키레이패스", "SSC 뷰티 클리닉"]) expect(saved).toContain(`<b>${n}</b>`);
    expect(saved).not.toContain("온라인 단품");
    expect(t.drawn()).toEqual({ rows: 11, contacts: 0, priced: 10, left: [] }); // 키레이패스 has no amount: not priced
    expect(saved).toContain(nw("가격 적힌 곳 10곳")); // the card counts the same
    // a card tool without saveAgentCard: the card goes through run, drawn at its 150 KB
    const v = new ExploreTracker(undefined, 0, "text", { text: ASK_ALL, card: { name: "sys_create_artifact", kind: "html" } });
    const mid = Array.from({ length: 450 }, (_, i) => ["도쿄", `${"아주 긴 클리닉 이름 ".repeat(3)}${i}`, "신주쿠역 동쪽 출구 도보 3분", "2.5mg 4주 ¥9,800", "카카오톡 상담", `https://c${i}.clinic.jp/${"경로".repeat(10)}`, "정리 사이트"]);
    const narrow = cardCtx({ toolSize: true });
    for (const [i, more] of [[0, true], [150, true], [300, false]] as const) await v.rowsTool(real)!.run({ rows: mid.slice(i, i + 150), more }, narrow.ctx);
    expect(bytes(saved)).toBeGreaterThan(100 * 1024);
    expect(bytes(saved)).toBeLessThanOrEqual(146 * 1024);
    expect(saved).toContain(nw(`<b>전체 450곳 중 ${v.drawn()!.rows}곳</b>${DOT}`));
    // more rows than one card holds (every field long), through the real tool's saveAgentCard: on as many cards as
    // they take, each under the limit, each region's cheapest on the first; the line says how many cards hold them all
    const u = new ExploreTracker(undefined, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    const longRow = (i: number) => ["도쿄", `클리닉 ${i} ${"아주긴이름".repeat(9)}`, "가".repeat(40), `${"가격설명".repeat(8)} ¥${9_000 + i}`, "카톡 ".repeat(20), `https://c${i}.clinic.jp/${"p".repeat(380)}`, "정리 사이트"];
    const many = Array.from({ length: 400 }, (_, i) => longRow(i));
    const wide = cardCtx();
    const rt = u.rowsTool(realArt())!;
    expect(u.takeLateCard("")).toBe(true);
    await rt.run({ rows: many.slice(0, 150), more: true }, wide.ctx);
    await rt.run({ rows: many.slice(150, 300), more: true }, wide.ctx);
    const last = await rt.run({ rows: many.slice(300), more: false }, wide.ctx);
    expect(last.ok).toBe(true);
    expect(JSON.stringify(last.data)).not.toContain("<");
    const d = u.drawn()!;
    const n = wide.saved.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(d).toMatchObject({ rows: 400, left: [], cards: n });
    expect(last.moreCards?.map((c) => (c.type === "artifact" ? c.artifactId : ""))).toEqual(wide.saved.slice(1).map((_, i) => `art_${i + 2}`));
    expect(last.data).toMatchObject({ artifactId: "art_1", cards: n });
    const on = wide.saved.map((c) => namesOn(c.content));
    expect(new Set(on.flat()).size).toBe(400); // every row on one card, none twice
    wide.saved.forEach((c, i) => {
      expect(c.title).toBe(`${wide.saved[0]!.title.replace(/ \(1\/\d+\)$/, "")} (${i + 1}/${n})`);
      expect(c.opts).toEqual({ agentCard: true });
      expect(bytes(c.content)).toBeLessThanOrEqual(300 * 1024 - 4 * 1024);
      expect(c.content).toContain(nw(`<b>전체 400곳 중 ${on[i]!.length}곳</b>${DOT}`));
      expect(c.content).toContain(`${nw(`<b>전체 400곳 중 ${on[i]!.length}곳</b>${DOT}`)} ${items(`카드 ${i + 1}/${n}`, i === 0 ? "나머지는 다음 카드에 이어져요" : "앞 카드에서 이어져요")}</p>`);
    });
    // the first card in the short form (no contact); a card that holds its rows whole shows them
    expect(wide.saved[0]!.content).not.toContain("카톡");
    expect(d.contacts).toBe(wide.saved.reduce((k, c, i) => k + (c.content.includes("카톡") ? on[i]!.length : 0), 0));
    expect(on[0]).not.toContain(`클리닉 388 ${"아주긴이름".repeat(9)}`); // the dearest on a later card
    expect(on.slice(1).flat()).toContain(`클리닉 388 ${"아주긴이름".repeat(9)}`);
    expect(u.cardLine()).toBe(`카드 ${n}장에 400곳을 모두 담았어요.`);
    // a round after it (a message steered in) gets the count on all the cards
    expect(u.note(0, "final")).toContain(`카드 ${n}장에 400곳을 담아 이미 띄웠어요(모시가 카드의 행을 센 수).`);
    // the tool's one card per answer holds for any other card: the model's, or the agent's without `more`; and `more`
    // continues only an agent card of this turn
    expect((await realArt().saveAgentCard!({ title: "x", html: "<p>x</p>" }, wide.ctx)).ok).toBe(false);
    expect((await realArt().run({ title: "x", kind: "html", content: "<p>x</p>" }, wide.ctx)).ok).toBe(false);
    const other = cardCtx();
    expect(await realArt().saveAgentCard!({ title: "x", html: "<p>x</p>", more: true }, other.ctx)).toMatchObject({ ok: false, data: { error: "no_card_to_continue" } });
    expect((await realArt().run({ title: "x", kind: "html", content: "<p>x</p>" }, other.ctx)).ok).toBe(true);
    expect(await realArt().saveAgentCard!({ title: "x", html: "<p>x</p>", more: true }, other.ctx)).toMatchObject({ ok: false, data: { error: "no_card_to_continue" } });
    // a round-up never seen: the cards hold every row sent, but not all there is
    const x = new ExploreTracker(undefined, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
    x.result({ name: "web_search", explore: "search" } as unknown as ToolDef, { ok: true, summary: "", data: { results: [{ title: "全国 マンジャロ 一覧 665院", url: "https://dir.jp/all" }] } });
    const xt = x.rowsTool(realArt())!;
    expect(x.takeLateCard("")).toBe(true);
    const xc = cardCtx();
    for (const [i, more] of [[0, true], [150, true], [300, false]] as const) await xt.run({ rows: many.slice(i, i + 150), more }, xc.ctx);
    expect(x.cardLine()).toBe(`카드 ${xc.saved.length}장에 400곳을 담았어요. 아직 안 본 정리 사이트: dir.jp.`);
    // a card that can't be saved (the second of three) is tried once more; refused again, the rows on it and on the
    // cards after it are named after the answer, and no card after it is made. Refused once only: all saved
    const more = Array.from({ length: 880 }, (_, i) => longRow(i));
    const failing = async (fails: number[]) => {
      const x = new ExploreTracker(undefined, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
      const c = cardCtx();
      const store = (c.ctx as { store: { createArtifact: (...a: unknown[]) => Promise<unknown> } }).store;
      const real2 = store.createArtifact.bind(store);
      let k = 0;
      store.createArtifact = (...a: unknown[]) => (fails.includes(k++) ? Promise.reject(new Error("db busy")) : real2(...a));
      const xt = x.rowsTool(realArt())!;
      expect(x.takeLateCard("")).toBe(true);
      for (let i = 0; i < more.length; i += 150) await xt.run({ rows: more.slice(i, i + 150), more: i + 150 < more.length }, c.ctx);
      return { t: x, saved: c.saved, tries: k };
    };
    const once = await failing([1]);
    expect(once.tries).toBe(4); // the second card twice
    expect(once.saved.length).toBe(3);
    expect(once.t.drawn()).toMatchObject({ cards: 3, rows: 880, left: [] });
    expect(once.t.cardLine()).toBe("카드 3장에 880곳을 모두 담았어요.");
    const { t: h, saved: kept, tries: k } = await failing([1, 2]);
    const hd = h.drawn()!;
    expect(k).toBe(3); // the first saved, the second refused twice, no third tried
    expect(kept).toHaveLength(1);
    expect(hd.cards).toBe(1);
    expect(hd.rows + hd.left.length).toBe(880);
    expect(hd.left.length).toBeGreaterThan(450); // two cards' rows
    expect(h.cardLine()).toContain(`카드 1장에 전체 880곳 중 ${hd.rows}곳을 담았어요. 카드에 못 담은 곳: `);
    expect(h.note(0, "final")).toContain(`카드 1장에 ${hd.rows}곳을 담아 이미 띄웠어요. ${hd.left.length}곳은 카드에 못 넣었어요: '`);
  });

  test("rows in two scripts that nothing matches (20+ each, a tenth of the rows): the card and the line say one place may be in it twice, and the sum is never said as all; a Korean name with its original in brackets is neither", async () => {
    const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/\u00a0/g, " ");
    const HANGUL_RE = /[가-힣]/;
    const draw = async (rows: string[][], tool = realArt()) => {
      const t = new ExploreTracker(undefined, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: { name: "sys_create_artifact", kind: "html" } });
      const { ctx, saved } = cardCtx();
      const rt = t.rowsTool(tool)!;
      expect(t.takeLateCard("")).toBe(true);
      for (let i = 0; i < rows.length; i += 150) await rt.run({ rows: rows.slice(i, i + 150), more: i + 150 < rows.length }, ctx);
      return { t, card: saved.at(-1)?.content ?? "", line: t.cardLine() };
    };
    const ko = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ["도쿄", `서울말 클리닉 ${from + i}호`, "신주쿠", "¥9,800", "", `https://k${from + i}.jp/`, "정리 사이트"]);
    const ja = (n: number) => Array.from({ length: n }, (_, i) => ["도쿄", `新宿クリニック${i}号`, "新宿", "9,800円", "", `https://j${i}.jp/`, "정리 사이트"]);
    const both = await draw([...ko(25), ...ja(25)]);
    expect(both.t.drawn()).toMatchObject({ rows: 50, left: [], overlap: true });
    expect(both.line).toBe("카드에 50곳 전부 정리했어요. 한국어 목록과 일본어 목록에 같은 곳이 다른 표기로 겹쳐 있을 수 있어서, 실제 곳 수는 이보다 적을 수 있어요.");
    expect(text(both.card)).toContain("50곳 · 한국어·일본어 목록에 같은 곳이 겹쳐 있을 수 있어요");
    // its first word whole: Chrome broke before its dot at 288 ('한국어 / ·일본어')
    expect(both.card).toContain(`${nw("한국어·일본어")} 목록에 같은 곳이 겹쳐 있을 수 있어요</p>`);
    // the original in brackets: matched by it, not a Korean name alone
    const bracketed = Array.from({ length: 25 }, (_, i) => ["도쿄", `신주쿠 클리닉 ${i}호 (新宿クリニック${i}号)`, "신주쿠", "¥9,800", "", `https://b${i}.jp/`, "정리 사이트"]);
    const named = await draw([...bracketed, ...ja(25)]);
    expect(named.t.drawn()!.overlap).toBeUndefined();
    expect(named.line).toBe("카드에 50곳 전부 정리했어요.");
    expect(text(named.card)).not.toContain("겹쳐");
    // under 20 in one script, or under a tenth of the rows: no such words
    for (const rows of [[...ko(19), ...ja(40)], [...ko(20), ...ja(190)]]) {
      const few = await draw(rows);
      expect(few.t.drawn()!.overlap).toBeUndefined();
      expect(few.line).toBe(`카드에 ${rows.length}곳 전부 정리했어요.`);
    }
    // more rows than one card holds: on more cards; the line and the cards give the lists' sum, never '전체 N곳'
    const long = (i: number, name: string) => ["도쿄", `${name} ${(HANGUL_RE.test(name) ? "아주긴이름" : "とても長い名前").repeat(9)}`, "가".repeat(40), `${"가격설명".repeat(8)} ¥${9_000 + i}`, "카톡 ".repeat(20), `https://c${i}.clinic.jp/${"p".repeat(380)}`, "정리 사이트"];
    const many = [...Array.from({ length: 200 }, (_, i) => long(i, `서울말 클리닉 ${i}`)), ...Array.from({ length: 200 }, (_, i) => long(200 + i, `新宿クリニック${i}`))];
    const cut = await draw(many);
    const d = cut.t.drawn()!;
    expect(d).toMatchObject({ rows: 400, left: [], overlap: true });
    expect(d.cards).toBeGreaterThanOrEqual(2);
    expect(cut.line).toBe(`카드 ${d.cards}장에 읽은 목록의 400곳을 모두 담았어요. 한국어 목록과 일본어 목록에 같은 곳이 다른 표기로 겹쳐 있을 수 있어서, 실제 곳 수는 이보다 적을 수 있어요.`);
    expect(cut.card).toContain(nw(`<b>목록 합계 400곳 중 ${namesOn(cut.card).length}곳</b>${DOT}`)); // the last card
    expect(text(cut.card)).toContain("한국어·일본어 목록에 같은 곳이 겹쳐 있을 수 있어요");
    // a card tool without saveAgentCard: one card at its 150 KB, the line names the rest by the lists' sum
    const one = await draw(many, { ...realArt(), saveAgentCard: undefined });
    const od = one.t.drawn()!;
    expect(od.cards).toBeUndefined();
    expect(od.left.length).toBeGreaterThan(0);
    expect(one.line).toContain(`카드에 ${od.rows}곳을 담았어요. 읽은 목록을 합치면 400곳이에요(카드 크기 한도로 지역마다 가격 없는 곳·비싼 곳부터 뺐어요). 한국어 목록과 일본어 목록에 같은 곳이 다른 표기로 겹쳐 있을 수 있어서, 실제 곳 수는 이보다 적을 수 있어요. 카드에 못 담은 곳: `);
    expect(one.line).toContain(` 외 ${od.left.length - 10}곳.`); // ten named, the rest as a count
    expect(one.line).not.toContain("전체");
    expect(one.card).toContain(nw(`<b>목록 합계 400곳 중 ${od.rows}곳</b>${DOT}`));
  });

  test("the card step gets the html guide first (server's lazy guide): the card step comes again and the card is made", async () => {
    const made: string[] = [];
    const artifact: ToolDef = {
      name: "sys_create_artifact",
      description: "Save an artifact",
      parameters: { type: "object", properties: { title: { type: "string" }, kind: { type: "string", enum: ["document", "html"] }, html: { type: "string" } } },
      icon: "doc",
      title: () => "화면 만드는 중",
      // the shape of the server's lazy guide (snap-html-5): content "" returns the guide, ok, no card
      run: async (a) =>
        typeof a.content === "string" && a.content.trim()
          ? (made.push(a.content), { ok: true, summary: "'치과' 화면을 만들었어요", data: { artifactId: "a1" } })
          : { ok: true, summary: "화면 가이드를 확인했어요", data: { guide: "GUIDE", message: 'Design guide for kind "html". Now call sys_create_artifact again with kind "html", a title and a fragment that follows it.' } },
    };
    const small = createRunTurn(llm, { deepSearch: { calls: 5 } });
    const rows = Array.from({ length: 9 }, (_, i) => `<a href="https://d${i}.jp/"><b>치과 ${i}</b><em>¥3,000</em><small>신주쿠 · 전화</small></a>`).join("");
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("r", "web_read", { url: "https://q1.example.jp/" }), call("d", "web_search", { query: "q4" })] },
      { toolCalls: [call("g", "sys_create_artifact", { title: "치과", kind: "html", content: "" })] },
      { toolCalls: [call("art", "sys_create_artifact", { title: "치과", kind: "html", content: `<div class="d">${rows}<p style="order:-1">{{곳수}}곳</p></div>` })] },
      { text: ["9곳을 카드로 정리했어요."] },
    );
    // a plain find (no '카드로', no '전부'): the model's own card, worth it with 8+ sites seen
    let n = 0;
    const wideSearch: ToolDef = { ...(webSearch as unknown as ToolDef), run: async (a) => ({ ok: true, summary: "결과 3개", data: { query: a.query, results: [0, 1, 2].map((k) => ({ title: `치과 ${n}-${k}`, url: `https://s${n++}-${k}.jp/` })) } }) };
    await run(small, DENTIST, { tools: [wideSearch, webRead, artifact] as unknown as ToolDef[] });
    expect(mock.requests).toHaveLength(5);
    for (const i of [2, 3]) expect(mock.requests[i]!.body.tools!.map((t) => t.function.name)).toEqual(["sys_create_artifact"]);
    expect(mock.requests[4]!.body.tool_choice).toBe("none");
    expect(made).toHaveLength(1);
    expect(made[0]).toContain('<p style="order:-1">9곳</p>'); // .d rows counted
  });

  test("a card made before the budget ends: no extra card step", async () => {
    const artifact: ToolDef = {
      name: "sys_create_artifact",
      description: "Save an artifact",
      parameters: { type: "object", properties: { kind: { type: "string", enum: ["table"] } } },
      icon: "doc",
      title: () => "표 만드는 중",
      run: async () => ({ ok: true, summary: "저장했어요" }),
    };
    const small = createRunTurn(llm, { deepSearch: { calls: 5 } });
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("r", "web_read", { url: "https://q1.example.jp/" }), call("art", "sys_create_artifact", { kind: "table" })] },
      { text: ["표로 정리했어요."] },
    );
    await run(small, ASK, { tools: [...TOOLS, artifact] });
    expect(mock.requests.map((r) => r.body.tool_choice)).toEqual(["required", "required", "none"]);
  });

  test("a page reader hides sys_web_fetch from the model; ToolDef.maxResultBytes raises a tool's result cap", async () => {
    const fetchTool: ToolDef = {
      name: "sys_web_fetch",
      description: "fetch",
      parameters: { type: "object", properties: { url: { type: "string" } } },
      icon: "link",
      title: () => "웹",
      run: async () => ({ ok: true, summary: "x" }),
    };
    const long = "가".repeat(3000); // 9 KB
    const bigRead: ToolDef = { ...(webRead as unknown as ToolDef), maxResultBytes: 12 * 1024, run: async () => ({ ok: true, summary: "읽었어요", data: { url: "https://a.jp/", text: long } }) };
    const smallRead: ToolDef = { ...(webRead as unknown as ToolDef), name: "web_read_small", run: async () => ({ ok: true, summary: "읽었어요", data: { url: "https://b.jp/", text: long } }) };
    mock.script.push({ toolCalls: [call("x", "web_read", { url: "https://a.jp/" }), call("y", "web_read_small", { url: "https://b.jp/" })] }, { text: ["읽었어요."] });
    await run(plainTurn, "이 두 페이지 읽어 줘", { tools: [fetchTool, bigRead, smallRead, weather] });
    expect(mock.requests[0]!.body.tools!.map((t) => t.function.name)).toEqual(["web_read", "web_read_small", "k_weather"]);
    const content = (id: string) => String(mock.requests[1]!.body.messages.find((m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === id)!.content);
    expect(content("x")).toContain(long);
    expect(content("y")).not.toContain(long);
    expect(Buffer.byteLength(content("y"))).toBeLessThanOrEqual(6 * 1024);
    // no reader: sys_web_fetch stays; a plain turn keeps max_tokens 2048
    mock.script.push({ text: ["네"] });
    await run(plainTurn, "안녕", { tools: [fetchTool, weather] });
    expect(mock.requests[2]!.body.tools!.map((t) => t.function.name)).toEqual(["sys_web_fetch", "k_weather"]);
    expect((mock.requests[2]!.body as { max_tokens?: number }).max_tokens).toBe(2048);
  });

  test("a quiet step (a long tool call being written) repeats the last status; a plain turn never does", async () => {
    const quiet = createRunTurn(llm, { deepSearch: { quietMs: 40, calls: 3 } });
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { text: ["다 찾았어요."], delayMs: 70 },
    );
    const { events } = await run(quiet, ASK);
    const statuses = events.flatMap((e) => (e.type === "status" ? [e.text] : []));
    const afterLastQuery = statuses.slice(statuses.lastIndexOf("'q3' 찾는 중") + 1);
    // the answer's step is quiet for ~70 ms before its first text: the beat repeats "생각하는 중"
    expect(afterLastQuery.filter((s) => s === "생각하는 중").length).toBeGreaterThanOrEqual(2);
    mock.script.push({ text: ["네."], delayMs: 70 });
    const plain = await run(plainTurn, ASK);
    expect(plain.events.filter((e) => e.type === "status" && e.text === "생각하는 중")).toHaveLength(1);
  });

  test("a tool call written as text (DSML) never reaches the person; a step that was only that is asked again, in words", async () => {
    const f = new ToolMarkupFilter();
    expect(f.push("찾은 곳은 이래요. <｜DS") + f.push("ML｜ calls><｜DSML｜ invoke name=\"x\">") + f.push("…") + f.flush()).toBe("찾은 곳은 이래요. ");
    expect(f.leaked).toBe(true);
    const g = new ToolMarkupFilter();
    expect(g.push("가격 <") + g.push("10만원") + g.flush()).toBe("가격 <10만원");
    expect(g.leaked).toBe(false);
    // the loop: the budget's last step (tools off) writes only DSML → one more step with the note, in words
    const small = createRunTurn(llm, { deepSearch: { calls: 3 } });
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_read", { url: "https://q1.example.jp/" })] },
      { text: ["<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"sys_create_artifact\">", "<｜DSML｜ parameter name=\"title\">표</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>"] },
      { text: ["세 곳을 찾았어요."] },
    );
    const { events, outcome } = await run(small, ASK);
    const shown = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
    expect(shown).not.toContain("DSML");
    expect(outcome.text).toBe("세 곳을 찾았어요.");
    expect(lastUser(2)).toContain("도구 호출 형식은 쓰지 말고");
    expect(mock.requests[1]!.body.tool_choice).toBe("none");
    // the retry carries no tools at all (with tools listed, DeepSeek writes the call as text again)
    expect(mock.requests[2]!.body.tools).toBeUndefined();
    expect(mock.requests[2]!.body.tool_choice).toBeUndefined();
    expect(JSON.stringify(outcome.messages)).not.toContain("DSML");
    expect(mock.requests).toHaveLength(3);
  });

  test("markup twice after a card: the card is the answer, not '앗, 답을 정리하지 못했어요'", async () => {
    const artifact: ToolDef = {
      name: "sys_create_artifact",
      description: "Save an artifact",
      parameters: { type: "object", properties: { kind: { type: "string", enum: ["html"] } } },
      icon: "doc",
      title: () => "화면 만드는 중",
      run: async () => ({ ok: true, summary: "화면을 만들었어요" }),
    };
    const small = createRunTurn(llm, { deepSearch: { calls: 4 } });
    const dsml = { text: ["<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"sys_create_artifact\">…</｜DSML｜ invoke>\n</｜DSML｜ calls>"] };
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_read", { url: "https://q1.example.jp/" })] },
      { toolCalls: [call("art", "sys_create_artifact", { kind: "html", content: "<ul></ul>" })] },
      dsml,
      dsml,
    );
    const { events, outcome } = await run(small, ASK, { tools: [...TOOLS, artifact] });
    expect(events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")).not.toContain("DSML");
    expect(outcome.text).toBe(CARD_DONE_REPLY);
    expect(lastUser(2)).toContain("카드는 이미 만들었어요");
    expect(mock.requests).toHaveLength(4);
  });

  test("voice: 찾아볼게요 first, in the same assistant message as the first calls", async () => {
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "q1" }), call("b", "web_search", { query: "q2" }), call("c", "web_search", { query: "q3" })] },
      { toolCalls: [call("r", "web_read", { url: "https://xn--2o2b11q2e68p.site/" })] },
      { text: ["스시자로가 있어요. 카톡으로 주문받아요."] },
    );
    const { events, outcome } = await run(deepTurn, ASK, { mode: "voice" });
    const texts = events.flatMap((e) => (e.type === "text" ? [e.delta] : []));
    expect(texts[0]).toBe(`${VOICE_SEARCH_PREFACE} `);
    expect(outcome.text.startsWith(VOICE_SEARCH_PREFACE)).toBe(true);
    expect(outcome.messages[0]).toMatchObject({ role: "assistant", content: `${VOICE_SEARCH_PREFACE} ` });
    expect(lastUser(2)).toContain("두세 곳만");
  });
});

describe("the rows card draws the lists' places ('전부')", () => {
  const ART = { name: "sys_create_artifact", kind: "html" } as const;
  const no = (i: number) => String(i).padStart(3, "0");
  /**
   * A web_read over fake pages: each page's items 20 at a time (nextItemsFrom), its pageLinks on the first read; a url
   * not there is a 404, `refuse` gives a url's error, `delayMs` a read's time. Every call is kept.
   */
  const siteReader = (
    pages: Record<string, { title: string; items: Record<string, unknown>[]; pageLinks?: { url: string; label?: string }[]; text?: string }>,
    o: { refuse?: Record<string, string>; delayMs?: number } = {},
  ) => {
    const calls: { url: string; itemsFrom?: number }[] = [];
    const def = {
      name: "web_read",
      description: "Read a page",
      parameters: { type: "object", properties: { url: { type: "string" }, itemsFrom: { type: "number" } }, required: ["url"] },
      icon: "link",
      explore: "read",
      run: async (a: { url: string; itemsFrom?: number }) => {
        calls.push(a);
        if (o.delayMs) await Bun.sleep(o.delayMs);
        const err = o.refuse?.[a.itemsFrom ? `${a.url}@${a.itemsFrom}` : a.url];
        if (err) return { ok: false, summary: "읽지 못했어요", data: { error: err, url: a.url } };
        const p = pages[a.url];
        if (!p) return { ok: false, summary: "페이지가 없어요", data: { error: "not_found", url: a.url, status: 404 } };
        const from = a.itemsFrom ?? 0;
        const next = from + 20 < p.items.length ? { nextItemsFrom: from + 20 } : {};
        return { ok: true, summary: "읽었어요", data: { url: a.url, title: p.title, items: p.items.slice(from, from + 20), itemsTotal: p.items.length, ...next, ...(from === 0 && p.pageLinks ? { pageLinks: p.pageLinks } : {}), ...(from === 0 && p.text ? { text: p.text } : {}) } };
      },
    } as unknown as ToolDef;
    return { def, calls };
  };
  /** the model's read of a page (its first items), as the loop feeds it to the tracker */
  const modelRead = async (t: ExploreTracker, r: ToolDef, url: string) => {
    t.call(r, "web_read", { url });
    t.result(r, await r.run({ url }, fakeCtx()));
  };
  /** the card's last page (more:false) with these rows; the card's html, statuses, line */
  const drawWith = async (t: ExploreTracker, reader: ToolDef | undefined, rows: string[][]) => {
    const { ctx, saved } = cardCtx();
    const rt = t.rowsTool(realArt(), reader)!;
    expect(t.takeLateCard("")).toBe(true);
    for (let i = 0; i < 2 && !t.drawn(); i++) {
      t.call(rt, "card_rows", {});
      await rt.run({ rows, more: false }, ctx);
    }
    return { rt, html: saved.at(-1)?.content ?? "", statuses: (ctx as unknown as { statuses: string[] }).statuses, line: t.cardLine() };
  };

  test("listPrice: a list entry's first amount with its dose and count or period, never another dose's or a won conversion", () => {
    expect(listPrice("도쿄 · 다카다노바바 · 9,100엔 · 17,100엔 · 1,100엔")).toBe("9,100엔");
    expect(listPrice("池袋東口まめクリニック · 2.5mg 4주 ¥13,800 약 116,800원 · 2.5mg ¥13,800 (약 116,800원) · 5mg ¥25,800")).toBe("¥13,800 2.5mg 4주");
    expect(listPrice("11,310円/1ヶ月 · 2,828円 · — · 自費")).toBe("11,310円 1ヶ月");
    // an amount the page cut short (right before an ellipsis, a last group under three digits or three digits at most
    // with no comma: aitoolog's '세금 포함 ¥19,2…', '¥12…') is none; the next is read; a whole one stays ('¥6,000…', and
    // one its unit closes)
    expect(listPrice("2.5mg · 4키트(약 1개월분) · 세금 포함 ¥19,2…")).toBe("");
    expect(listPrice("세금 포함 ¥19,2...")).toBe("");
    expect(listPrice("마운자로 2.5mg ¥12…")).toBe("");
    expect(listPrice("마운자로 2.5mg ¥6,60…")).toBe("");
    expect(listPrice("마운자로 2.5mg ¥6,000…")).toBe("¥6,000 2.5mg");
    expect(listPrice("마운자로 2.5mg ¥9800…")).toBe("¥9800 2.5mg");
    expect(listPrice("마운자로 2.5mg ¥980 · 5mg ¥1,980")).toBe("¥980 2.5mg"); // no ellipsis: as written
    expect(listPrice("2.5mg ¥19,2… · 5mg ¥25,800")).toBe("¥25,800 5mg");
    expect(listPrice("19,200円… · 9,800円")).toBe("19,200円");
    // by the month: '월' leads it ('매월' too), not a month's name ('3월') nor a count of months ('1개월')
    expect(listPrice(", 약 1023m, 월 200000원")).toBe("월 200000원");
    expect(listPrice("헬스 · 매월 55,000원")).toBe("월 55,000원");
    expect(listPrice("월200,000원 · 24시간")).toBe("월 200,000원");
    expect(listPrice("3월 200,000원")).toBe("200,000원");
    expect(listPrice("1개월 30,000원")).toBe("30,000원 1개월");
    expect(listPrice("3,000円/1本 · 3,000円 · 3,300円 · 15,300円 · 自費")).toBe("3,000円 1本");
    expect(listPrice("人形町 닌교초 · 역 도보 3분 · 2.5mg · 1개 · 세금 포함 ¥6,000 약 5만원 · 온라인")).toBe("¥6,000 2.5mg 1개");
    expect(listPrice("銀座 긴자 · 역 도보 3분 · 2.5mg · 3개월(12본) · 세금 포함 ¥34,584 약 28.9만원")).toBe("¥34,584 2.5mg 3개월 12본");
    expect(listPrice("📍 地図を開く（別タブ） · 自費診療 · 2.5mg 15,000円 / 5mg 26,000円（1ヶ月あたりの価格） · 保険")).toBe("15,000円 2.5mg 1ヶ月");
    expect(listPrice("2.5mg 3,850円 / 5mg 7,700円 / 7.5mg 11,000円（1本あたりの…")).toBe("3,850円 2.5mg 1本");
    expect(listPrice("온라인 · 냉장 배송 · 4펜 ¥11,000 · 상담 무료")).toBe("¥11,000 4펜");
    expect(listPrice("오사카 · 신사이바시 · 마운자로 2.5mg ¥4,500 약 3.8만원 1주(1개) 상세")).toBe("¥4,500 2.5mg 1주 1개");
    expect(listPrice("2.5mg 15,000円 5mg 2ヶ月分 30,000円")).toBe("15,000円 2.5mg"); // the next dose's period is not this price's
    expect(listPrice("elife(イーライフ) · 参考値 0円 · 2.5mg 9,800円")).toBe("9,800円 2.5mg"); // 0 is no price
    expect(listPrice("初診料 0円 / 2.5mg 12,000円")).toBe("12,000円 2.5mg");
    for (const none of [undefined, "", "자세히 보기 · 공식 사이트", "24곳 · 3 · 1", "参考値 0円", "¥0"]) expect(listPrice(none)).toBe("");
  });

  test("listPrice: an amount right after a fee's name is the fee, never the price; a fee marked included or free is no fee, so the amount after it is the price; a Korean visit's amount is read when the text has no other price", () => {
    // included or free: the amount after it is read (design-director's examples)
    for (const [text, price] of [
      ["送料込み 19,800円", "19,800円"],
      ["送料無料 19,800円", "19,800円"],
      ["診察料込 14,300円", "14,300円"],
      ["初診料無料・2.5mg 9,800円", "9,800円 2.5mg"],
      ["배송비 포함 19,800원", "19,800원"],
      ["진찰료 무료 9,800원", "9,800원"],
      ["送料 0円 2.5mg 9,800円", "9,800円 2.5mg"],
      ["2.5mg 9,800円（送料込み）", "9,800円 2.5mg"],
      ["送料(込み) 19,800円", "19,800円"], // a bracket other than a tax one: the mark is the fee's
      ["診察料（無料）9,800円", "9,800円"],
    ])
      expect([text, listPrice(text)]).toEqual([text, price]);
    // a fee's own amount is skipped: the price after it is read, or none
    for (const [text, price] of [
      ["送料 550円 · 2.5mg 9,800円", "9,800円 2.5mg"],
      ["送料 550円 2.5mg 9,800円", "9,800円 2.5mg"],
      ["初診料：2,000円 再診料：1,100円 2.5mg：9,800円", "9,800円 2.5mg"],
      ["비용: 초진 진료비 1,100엔. 방문 전 가격 2.5mg 10,000엔", "10,000엔 2.5mg"],
      ["초진 진료비 1,100엔 · 2.5mg 22,000엔", "22,000엔 2.5mg"],
      ["초진료 1,650엔, 재진료 990엔, 진단서 3,300엔. 4펜 가격 2.5mg 12,000엔", "12,000엔 4펜 2.5mg"],
      ["4本/月、クール便送料2,350円別途 · 4本 · ¥16,000", "¥16,000 4本"],
      ["診察料:0円 · 送料:550円 · <2.5mg(税込)> · 定期便: 22,000円", "22,000円"],
      ["診察料 1,650円", ""],
      ["送料（税込）550円", ""],
      ["送料一律550円", ""],
      ["배송비는 550엔", ""],
      ["配送料 · 550 円/回", ""],
      ["送料:430円~2000円 · アプリ利用料:330円", ""],
      // a table's label piece: the next piece is its value, all of it
      ["診察料 · 無料 · 送料 · ¥550(クール便:¥1,100) · 支払方法", ""],
      ["初診料 · 2,000円 · 再診料 · 1,000円", ""],
      ["送料 · 15,000円(税込)以上で送料無料", ""],
    ])
      expect([text, listPrice(text)]).toEqual([text, price]);
    // a note or a way of paying or shipping right after a fee's value goes on with that fee; a fee table's head (two
    // fees' names in a row) has fees after it, another clinic's too (2026-11-18)
    for (const [text, price] of [
      ["診察料 · 無料 · ※薬の処方がない場合は1,650円(税込) · 送料 · クール便1,100円(税込) · 大阪での対面診療の有無 · 無", ""],
      ["診察料 · 無料 · ※薬の処方がない場合は1,650円 · ※年末年始を除く · 2.5mg 22,000円", "22,000円 2.5mg"],
      ["送料 · 0 円 · クレジット決済 500 円/代金引換 1,000 円 · 2.5mg 19,800円", "19,800円 2.5mg"],
      ["送料 · ¥550 · 代金引換 330円 · 銀行振込 0円 · コンビニ後払い 220円 · クール便 1,100円 · 2.5mg 19,800円", "19,800円 2.5mg"],
      ["送料 · 550円 · 大阪 · ※初回限定 9,800円", "9,800円"], // a note after another piece is no fee's
      ["2.5mg · ※初回限定 9,800円", "9,800円 2.5mg"],
      ["送料 · 550円 · 2.5mg 19,800円(クレジット決済・代金引換可) ※税込", "19,800円 2.5mg"], // a note's word inside a piece
      ["クリニック · 診察料 · 送料 · 0 円 · クレジット決済 500 円/代金引換 1,000 円(薬代15,000円以上で無料) · クリニックフォア · 1,650 円(対象の決済履歴があり)", ""],
      ["初診料 · 2,000円 · 再診料 · 1,000円 · 2.5mg 9,800円", "9,800円 2.5mg"], // a fee's value between: no head
    ])
      expect([text, listPrice(text)]).toEqual([text, price]);
    // far from the fee's name (another sentence, a piece after the next): the amount is read
    expect(listPrice("送料は別途かかります。 2.5mg 9,800円")).toBe("9,800円 2.5mg");
    expect(listPrice("送料 · 無料 · 9,800円")).toBe("9,800円");
    expect(listPrice("送料について · 9,800円")).toBe("9,800円");
    // a Korean visit's amount (진료비, 진찰료, 초진료, 재진료, 진단서) is a Korean clinic's, pediatrician's or dentist's price:
    // read when nothing else is, shipping never (design-director's examples)
    for (const [text, price] of [
      ["진료비 15,000원", "15,000원"],
      ["소아과 · 진료비 15,000원 · 주차 무료", "15,000원"],
      ["비급여 진료비 300,000원 · 원외 진료비 20,000원", "300,000원"],
      ["진찰료 3,000원 · 배송비 3,500원", "3,000원"],
      ["배송비 3,500원 · 진찰료 3,000원", "3,000원"],
      ["送料 550円 · 진단서 20,000원", "20,000원"],
      ["치과 · 진료비 · 30,000원", "30,000원"], // a label piece too
      ["送料 · 550円 · 진료비 · 30,000원", "30,000원"],
      ["送料 550円 · 診察料 1,650円", ""],
      ["送料 · 550円 · 初診料 · 2,000円", ""],
    ])
      expect([text, listPrice(text)]).toEqual([text, price]);
    // each fee's name, with the price after it or none; a Korean visit's own amount when no price is after it
    for (const fee of ["送料", "配送料", "配送費", "郵送料", "診察料", "診察代", "初診料", "再診料", "診断書", "アプリ利用料", "システム利用料", "배송비", "택배비", "진료비", "진찰료", "초진료", "재진료", "진단서"]) {
      const ko = ["진료비", "진찰료", "초진료", "재진료", "진단서"].includes(fee);
      expect([fee, listPrice(`${fee} 1,100円 · 상담 후 결정`)]).toEqual([fee, ko ? "1,100円" : ""]);
      expect([fee, listPrice(`${fee}：1,100円 2.5mg 9,800円`)]).toEqual([fee, "9,800円 2.5mg"]);
    }
  });

  test("listPrice: the count or period words right before a next amount are that amount's, not this price's; a piece naming a dose is never a fee's value or note (2026-11-18)", () => {
    for (const [text, price] of [
      // the next amount's own words: a pen's price after a month's ('1本3,250円'), a month's after a pen's
      ["1ヶ月定期便（4本） 月13,000円 1本3,250円 · 3ヶ月定期便（12本） 月12,000円 1本3,000円・総額36,000円", "13,000円 1ヶ月 4本"],
      ["月13,000円 1本 3,250円", "13,000円"],
      ["1本 9,250円、1ヶ月分 37,000円", "9,250円 1本"],
      ["8,500円 1本あたり2,125円", "8,500円"],
      ["1本 6,600円 2本 11,000円 4本 19,800円", "6,600円 1本"],
      ["2.5mg 3,250円 1ヶ月 4本 13,000円", "3,250円 2.5mg"],
      ["1本 5,500円 4本 1ヶ月分 22,000円", "5,500円 1本"],
      ["9,800円 1本 ： 3,250円", "9,800円"],
      ["후쿠오카 미라이 클리닉: 2.5mg 4펜 12,000엔, 1펜 3,000엔 낱개 구매 가능.", "12,000엔 2.5mg 4펜"],
      ["3,750円〜（6本まとめ購入時） / 通常4本12,500円", "3,750円 6本"],
      // after a slash or a bracket right after the amount, its own: kept even with an amount next
      ["15,000円/1ヶ月 30,000円/3ヶ月", "15,000円 1ヶ月"],
      ["9,800円（1ヶ月分） 2回目以降 12,000円", "9,800円 1ヶ月分"],
      ["2,500円/1本", "2,500円 1本"],
      ["12,000円 1ヶ月分", "12,000円 1ヶ月分"], // no next amount: as before
      // an ordinal ('2ヶ月目', '2か月目まで', '2개월째') is no quantity: neither this amount's nor the next's
      ["1ヶ月定期 8,350円 2ヶ月目以降9,350円 · 3ヶ月定期 7,883円同8,883円", "8,350円 1ヶ月"],
      ["2.5mg・4本：限定LPの初月14,980円／2ヶ月目以降24,980円", "14,980円 2.5mg 4本"],
      ["4本（1ヶ月分）：2.5mg 9,460円（2か月目まで）・6,930円", "9,460円 4本 1ヶ月分 2.5mg"],
      ["2ヶ月目以降 9,350円", "9,350円"],
      ["3本目から 2,000円", "2,000円"],
      ["2개월째 99,000원", "99,000원"],
      ["2週間目から 9,800円 4本", "9,800円 4本"],
      // a piece naming a dose after a fee: the medicine's, read
      ["送料 · 無料 · ※2.5mg 1本 4,980円", "4,980円 2.5mg 1本"],
      ["送料 · 無料 · ※初回限定 2.5mg 9,800円", "9,800円 2.5mg"],
      ["送料 · 550円 · ※初回限定 2.5mg 9,800円", "9,800円 2.5mg"], // 初回限定 is not shown: an amount and its count words only, as before
      ["診察料 · 送料 · 2.5mg 9,800円", "9,800円 2.5mg"],
      ["送料 · 2.5mg 9,800円", "9,800円 2.5mg"],
      ["送料 · 0円 · ※2.5mg(4本) 19,800円", "19,800円 2.5mg 4本"],
      // a note with no dose still goes on with the fee; a fee table's head with a fee value next still ends the reading
      ["診察料 · 無料 · ※薬の処方がない場合は1,650円", ""],
      ["送料 · 無料 · ※1本 4,980円以上で無料", ""],
      ["送料 · 550円 · 19,800円(クレジット決済・代金引換可) ※税込", "19,800円"], // a note's word inside a piece, no dose
      ["クリニック · 診察料 · 送料 · 0 円 · 2.5mg 9,800円", ""],
    ])
      expect([text, listPrice(text)]).toEqual([text, price]);
  });

  test("listPrice, watched (design-director on deep-36-2, none in the saved texts): a count after an amount with no mark before the next amount is the next amount's; a fee's value naming a dose reads as the price", () => {
    for (const [text, price] of [
      // '1本' between two amounts with nothing else: the next amount's words (deep-36), so this price has no count
      ["4,980円 1本 8,800円 2本", "4,980円"],
      // with a slash, a bracket, or a piece apart, the count is this amount's
      ["4,980円/1本 8,800円/2本", "4,980円 1本"],
      ["4,980円（1本） 8,800円（2本）", "4,980円 1本"],
      ["4,980円 1本 · 8,800円 2本", "4,980円 1本"],
      ["1本 4,980円 2本 8,800円", "4,980円 1本"],
      // a fee's value that names a dose is no fee's value (deep-36's dose rule): read as the price, with its dose
      ["診察料 · 2.5mg処方時 1,650円", "1,650円 2.5mg"],
      ["診察料 · 2.5mg処方時 1,650円 · 2.5mg 9,800円", "1,650円 2.5mg"],
      // a note with no dose after a fee's value: still the fee's
      ["診察料 · 無料 · ※薬の処方がない場合は1,650円", ""],
    ])
      expect([text, listPrice(text)]).toEqual([text, price]);
  });

  test("a list entry with a fee's amount alone is drawn with no price: in the list, out of '가격 적힌 곳' and of the summary's min and max", async () => {
    const url = "https://list.jarodb.kr/mounjaro";
    const texts = ["도쿄 · 送料 · 550円(税込)", "도쿄 · 배송비 550엔", "도쿄 · 送料 550円 · 2.5mg 9,800円", ...Array.from({ length: 27 }, (_, i) => `${i % 2 ? "도쿄" : "오사카"} · 2.5mg ${(10_000 + i * 100).toLocaleString("en-US")}円`)];
    const entries = texts.map((text, i) => ({ name: `클리닉 ${no(i)}`, key: `클리닉${no(i)}`, url: `https://list.jarodb.kr/mounjaro/clinic/c${i}`, text }));
    const r = siteReader({ [url]: { title: "일본 마운자로 병원 30곳", items: entries } });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, r.def, url);
    const { html } = await drawWith(t, r.def, []);
    expect(namesOn(html).sort()).toEqual(entries.map((it) => it.name).sort());
    expect(html).toContain(nw("가격 적힌 곳 28곳"));
    expect(html).toContain(`<p>${items("2.5mg 기준 최저 9,800円", "최고 12,600円")}</p>`);
    expect(html).not.toContain("550");
  });

  test("a list begun is read to its end at the card (itemsFrom, no cap, one at a time) and its places drawn from it: grouped, priced, linked, checked as a list's", async () => {
    const url = "https://list.jarodb.kr/mounjaro";
    const items = Array.from({ length: 130 }, (_, i) => ({
      name: `${i + 1}. 클리닉 ${no(i)} ▶`,
      key: `클리닉${no(i)}`,
      url: `https://list.jarodb.kr/mounjaro/clinic/c${i}`,
      text: `${i % 2 ? "도쿄" : "오사카"} · 역 앞 · ${(8_000 + i * 10).toLocaleString("en-US")}엔 · 14,000엔`,
    }));
    const r = siteReader({ [url]: { title: "일본 마운자로 병원 130곳", items } });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, r.def, url);
    expect(t.listPlaces()).toBe(20);
    // the model sends one place found elsewhere (its own group name), none of the list's
    const { rt, html, statuses, line } = await drawWith(t, r.def, [["도쿄 (23구)", "공식 클리닉", "신주쿠", "2.5mg 4주 ¥9,800", "03-1234-5678", "https://official-clinic.jp/", "공식 페이지"]]);
    expect(rt.timeoutMs).toBe(CARD_READ_MS + 30_000);
    // two minutes of reading on, inside the turn's 230 s (the lead's call: a slow day's '전부' is not cut short)
    expect([CARD_READ_MS, CARD_READ_BY_MS]).toEqual([120_000, 230_000]);
    expect(r.calls.slice(1)).toEqual([20, 40, 60, 80, 100, 120].map((from) => ({ url, itemsFrom: from })));
    expect(statuses).toContain(`${CARD_STATUS} · list.jarodb.kr 목록 21번째부터`);
    expect(t.drawn()).toMatchObject({ rows: 131, left: [], listed: 130 });
    expect(line).toBe("카드에 131곳 전부 정리했어요.");
    // Tokyo's under the model's group for it, the list number and arrow gone, the first amount, its own page
    expect(html).toContain("<h3>도쿄 (23구)<span>66곳</span></h3>");
    expect(html).toContain("<h3>오사카<span>65곳</span></h3>");
    expect(namesOn(html)).toContain("클리닉 129");
    expect(html).toContain(`<a href="https://list.jarodb.kr/mounjaro/clinic/c0"><div class="t"><b>클리닉 000</b>`);
    expect(html).toContain("<b>8,000엔</b>");
    expect(html).not.toContain("14,000엔");
    expect(html).toContain(LIST_CHECK);
    // no reader: the places read are drawn, none read on
    const n = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    const r2 = siteReader({ [url]: { title: "일본 마운자로 병원 130곳", items } });
    await modelRead(n, r2.def, url);
    const bare = await drawWith(n, undefined, []);
    expect(bare.rt.timeoutMs).toBeUndefined();
    expect(r2.calls).toHaveLength(1);
    expect(n.drawn()).toMatchObject({ rows: 20, listed: 20 });
  });

  test("not '전부', or a number asked: the card holds the model's rows only, and reads nothing on", async () => {
    const url = "https://list.jarodb.kr/mounjaro";
    const items = Array.from({ length: 40 }, (_, i) => ({ name: `클리닉 ${no(i)}`, key: `클리닉${no(i)}`, url: `https://c${i}.example.jp/`, text: "도쿄 · 9,000엔" }));
    for (const text of ["도쿄 마운자로 클리닉 카드로", "일본 마운자로 클리닉 20곳 전부 카드로"]) {
      const r = siteReader({ [url]: { title: "마운자로 병원 목록", items } });
      const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text, card: ART });
      await modelRead(t, r.def, url);
      const sent = items.slice(0, 3).map((it) => ["도쿄", it.name, "", "9,000엔", "", it.url, "정리 사이트"]);
      const { rt } = await drawWith(t, r.def, sent);
      expect(rt.timeoutMs).toBeUndefined();
      expect(r.calls).toHaveLength(1);
      expect(t.drawn()!.listed).toBeUndefined();
    }
  });

  /** mirai-like: a front page (一覧665院) of clinics linking their prefecture's page, and a menu of some prefectures */
  const MIRAI = "https://md.mirai-medical.clinic/";
  const pref = (p: number) => `${MIRAI}prefectures${String(p).padStart(2, "0")}/`;
  const front = {
    title: "全国のマンジャロが安いおすすめクリニック一覧665院",
    items: [
      { name: "医療法人森本整形外科 大阪市 ▶", key: "森本整形外科大阪市", url: pref(27), area: "大阪市", links: [{ url: "http://www.morimoto-clinic.jp/" }], text: "2,500円 /1本 · 2,500円 · 自費" },
      { name: "細川外科クリニック 名古屋市 ▶", key: "細川外科名古屋市", url: pref(23), area: "名古屋市", links: [{ url: "https://www.hosoge.com/" }], text: "2,750円 /1本 · 2,750円" },
      { name: "むらた日帰り外科手術クリニック 仙台市 ▶", key: "むらた日帰り外科手術仙台市", url: pref(4), area: "仙台市", links: [{ url: "http://www.murata-higaerigeka.com/" }], text: "11,310円 /1ヶ月 · 2,828円" },
      { name: "Ａｃｔｕａｌｌｙクリニック 台東区 ▶", key: "actually台東区", url: pref(13), area: "台東区", links: [{ url: "https://www.actually.co.jp/" }], text: "11,980円 /1ヶ月" },
      { name: "ぐんまの森クリニック 高崎市 ▶", key: "ぐんまの森高崎市", url: pref(10), area: "高崎市", links: [{ url: "https://www.gunmanomori-clinic.jp/" }], text: "3,000円 /1本" },
      { name: "やまもと内科クリニック 広島市 ▶", key: "やまもと内科広島市", url: pref(34), area: "広島市", links: [{ url: "https://yamamoto-naika-clinic.com/" }], text: "3,000円 /1本" },
      { name: "ミライメディカルクリニック マンジャロ オンライン", key: "ミライメディカルマンジャロオンライン", url: "https://mirai-medical.clinic/medical-diet/mounjaro/", area: "オンライン", text: "マンジャロ 2,750円 /1本 · 無料" },
      { name: "デジタルクリニック リベルサス オンライン", key: "デジタルリベルサスオンライン", url: "https://digital-clinic.life/lp/diet/", area: "オンライン", text: "リベルサス3mg 6,948円 /1ヶ月" },
    ],
    pageLinks: [21, 25, 33, 17, 30, 1].map((p) => ({ url: pref(p), label: "県" })),
  };
  /** a prefecture's page: its clinics, numbered, their city after them, each a map pin with its own site */
  const prefPage = (p: number, ward: string, city: string, n: number, first?: string) => ({
    title: `マンジャロおすすめクリニック一覧${n + 3}院`,
    items: Array.from({ length: n }, (_, i) => ({
      name: `${i + 1}. ${i === 0 && first ? first : `${city}クリニック${no(p * 100 + i)}`}（${city}）`,
      key: `${city}${no(p * 100 + i)}`,
      url: `https://www.openstreetmap.org/?mlat=35.${p}${i}&mlon=139.${i}`,
      area: `${ward}`,
      links: [{ url: `https://clinic${p}-${i}.jp/price/` }],
      text: `📍 地図を開く（別タブ） · 自費診療 料金の記載あり · 2.5mg ${(15_000 + i * 100).toLocaleString("en-US")}円 / 5mg 26,000円（1ヶ月あたりの価格） · 保険`,
    })),
  });
  const miraiPages = () => ({
    [MIRAI]: front,
    [pref(13)]: prefPage(13, "東京都渋谷区", "渋谷区", 45),
    [pref(27)]: prefPage(27, "大阪府大阪市北区", "大阪市", 30, "医療法人森本整形外科"),
    [pref(21)]: prefPage(21, "岐阜県岐阜市", "岐阜市", 5), // under 8: a region page is a list however few it holds
  });

  test("a directory read in part (一覧665院 over 8 entries): the card reads its region pages, all 47 prefectures by their codes, each to its end; its clinics reach the card with their own sites; the line counts places", async () => {
    const r = siteReader(miraiPages());
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, r.def, MIRAI);
    const { html, statuses, line } = await drawWith(t, r.def, [["도쿄 (23구)", "공식 클리닉", "신주쿠", "¥9,800", "", "https://official-clinic.jp/", "공식 페이지"]]);
    // one read per prefecture, Tokyo and Osaka first, and the pages that held more read on
    const prefReads = r.calls.filter((c) => c.url.includes("/prefectures") && !c.itemsFrom).map((c) => c.url);
    expect(prefReads).toHaveLength(47);
    expect(new Set(prefReads).size).toBe(47);
    expect(prefReads.slice(0, 2)).toEqual([pref(13), pref(27)]);
    expect(r.calls.filter((c) => c.itemsFrom)).toEqual([
      { url: pref(13), itemsFrom: 20 },
      { url: pref(13), itemsFrom: 40 },
      { url: pref(27), itemsFrom: 20 },
    ]);
    expect(statuses).toContain(`${CARD_STATUS} · md.mirai-medical.clinic 지역 페이지 1/47`);
    // the front's 7 (not its other drug's entry) and the region pages' 80, the clinic on both once; the model's one
    const names = namesOn(html);
    expect(names.some((n) => n.includes("リベルサス"))).toBe(false);
    expect(names).toContain("ミライメディカルクリニック マンジャロ オンライン");
    expect(names).toContain("渋谷区クリニック1344(渋谷区)");
    expect(names).toContain("医療法人森本整形外科 大阪市");
    expect(names).not.toContain("医療法人森本整形外科(大阪市)");
    expect(t.drawn()).toMatchObject({ rows: 1 + 7 + 79, left: [] });
    // a map pin's entry links its own site; Tokyo under the model's group, Gifu under its own
    expect(html).not.toContain("openstreetmap");
    expect(html).toContain('href="https://clinic13-0.jp/price/"');
    expect(html).toMatch(/<h3>도쿄 \(23구\)<span>47곳<\/span><\/h3>/); // 45 + Actually (台東区) + the model's
    expect(html).toContain("<h3>기후<span>5곳</span></h3>");
    expect(html).toContain("<h3>온라인<span>1곳</span></h3>");
    expect(html).toContain("<b>15,000円</b>");
    // the site says 665: what its pages held is less, said as places
    expect(line).toBe(`카드에 ${1 + 7 + 79}곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(665곳 중 86곳).`);
  });

  test("an index of a directory (its stations named, 281 clinics, none on it): the card reads its own station pages, or with none on it the site's front page and from there its region pages; not read past, the line says it was the index only; a page naming many places with no index wording is none", async () => {
    const STATIONS = `${MIRAI}stations/`;
    const index = {
      title: "マンジャロ処方クリニックを主要駅から探す",
      items: [],
      text: "# マンジャロ処方クリニックを主要駅から探す\n\n駅から1km以内にマンジャロを扱うクリニックがある主要駅を62駅ぶん載せています。合わせて281院が対象です。駅を選ぶとその駅の一覧に移動します。\n\n62駅主要駅 281院掲載",
      pageLinks: [{ url: `${MIRAI}lp?u=mounjaro` }, { url: `${MIRAI}medical-diet/libersus/` }, { url: `${MIRAI}company/` }],
    };
    const r = siteReader({ ...miraiPages(), [STATIONS]: index });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, r.def, STATIONS);
    const { statuses, line } = await drawWith(t, r.def, []);
    expect(r.calls[1]).toEqual({ url: MIRAI });
    expect(r.calls.filter((c) => c.url.includes("/prefectures") && !c.itemsFrom)).toHaveLength(47);
    expect(statuses).toContain(`${CARD_STATUS} · md.mirai-medical.clinic 첫 페이지`);
    expect(t.drawn()).toMatchObject({ rows: 7 + 79 });
    expect(line).toBe(`카드에 ${7 + 79}곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(665곳 중 86곳).`);
    // the front page refused: the index only
    const shut = siteReader({ ...miraiPages(), [STATIONS]: index }, { refuse: { [MIRAI]: "blocked" } });
    const n = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(n, shut.def, STATIONS);
    expect((await drawWith(n, shut.def, [["도쿄 (23구)", "공식 클리닉", "신주쿠", "¥9,800", "", "https://official-clinic.jp/", "공식 페이지"]])).line).toBe("카드에 1곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(색인만 읽음).");
    expect(shut.calls.map((c) => c.url)).toEqual([STATIONS, MIRAI]);
    // its own station pages (the links under its path): read as a directory's region pages, the front page not
    const st = (i: number) => `${STATIONS}${["shinjuku", "umeda", "tenjin"][i]}/`;
    const stationPage = (i: number) => ({ title: `${["新宿", "梅田", "天神"][i]}駅周辺のマンジャロ処方クリニック`, items: Array.from({ length: 9 }, (_, j) => ({ name: `駅クリニック${no(i * 10 + j)}`, key: `駅${no(i * 10 + j)}`, url: `https://st${i}-${j}.jp/`, text: "2.5mg 3,000円" })) });
    const own = siteReader({ ...miraiPages(), [STATIONS]: { ...index, pageLinks: [0, 1, 2].map((i) => ({ url: st(i) })) }, [st(0)]: stationPage(0), [st(1)]: stationPage(1), [st(2)]: stationPage(2) });
    const o = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(o, own.def, STATIONS);
    const byStation = await drawWith(o, own.def, []);
    expect(own.calls.map((c) => c.url)).toEqual([STATIONS, st(0), st(1), st(2)]);
    expect(o.drawn()).toMatchObject({ rows: 27 });
    expect(byStation.line).toBe("카드에 27곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(281곳 중 27곳).");
    // two station links only: no directory of its own, the front page is read
    const two = siteReader({ ...miraiPages(), [STATIONS]: { ...index, pageLinks: [0, 1].map((i) => ({ url: st(i) })) }, [st(0)]: stationPage(0), [st(1)]: stationPage(1) });
    const tw = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(tw, two.def, STATIONS);
    await drawWith(tw, two.def, []);
    expect(two.calls[1]).toEqual({ url: MIRAI });
    // a list of its own with the index's wording (9 of 25): a list, not an index
    const area = "https://area.example.jp/list/";
    const listed = siteReader({ [area]: { title: "マンジャロ処方クリニックをエリアから探す 全25院", items: Array.from({ length: 9 }, (_, i) => ({ name: `エリアクリニック${no(i)}`, key: `エリア${no(i)}`, url: `https://ar${i}.jp/`, text: "2.5mg 3,000円" })) } });
    const ar = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(ar, listed.def, area);
    await drawWith(ar, listed.def, []);
    expect(listed.calls).toHaveLength(1);
    // the front page read by the model too: not read again, its region pages are
    const both = siteReader({ ...miraiPages(), [STATIONS]: index });
    const bt = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(bt, both.def, STATIONS);
    await modelRead(bt, both.def, MIRAI);
    await drawWith(bt, both.def, []);
    expect(both.calls.filter((c) => c.url === MIRAI)).toHaveLength(1);
    expect(both.calls.filter((c) => c.url.includes("/prefectures") && !c.itemsFrom)).toHaveLength(47);
    // a front page that is a short list of its own: the places the index names and those read
    const plain = siteReader({ [STATIONS]: index, [MIRAI]: { title: "マンジャロ処方クリニック", items: Array.from({ length: 10 }, (_, i) => ({ name: `前クリニック${no(i)}`, key: `前${no(i)}`, url: `https://fr${i}.jp/`, text: "2.5mg 3,000円" })) } });
    const pl = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(pl, plain.def, STATIONS);
    expect((await drawWith(pl, plain.def, [])).line).toBe("카드에 10곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(281곳 중 10곳).");
    // an index naming a few places: none to read on
    const small = siteReader({ ...miraiPages(), [STATIONS]: { ...index, text: "駅を選ぶとその駅の一覧に移動します。主要駅の12院を載せています。" } });
    const sm = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(sm, small.def, STATIONS);
    await drawWith(sm, small.def, [["도쿄 (23구)", "공식 클리닉", "신주쿠", "¥9,800", "", "https://official-clinic.jp/", "공식 페이지"]]);
    expect(small.calls).toHaveLength(1);
    // an article naming 26 clinics in its title, read as text: no index, nothing read on
    const article = "https://column.example.jp/tokyo-mounjaro/";
    const a = siteReader({ [article]: { title: "東京でマンジャロ処方のクリニック26院", items: [], text: "東京でマンジャロを処方しているクリニック26院を紹介します。料金と通いやすさで比べました。" } });
    const at = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(at, a.def, article);
    expect((await drawWith(at, a.def, [["도쿄 (23구)", "공식 클리닉", "신주쿠", "¥9,800", "", "https://official-clinic.jp/", "공식 페이지"]])).line).toBe("카드에 1곳 전부 정리했어요.");
    expect(a.calls).toHaveLength(1);
  });

  test("a list of its site's region round-ups ('大阪でマンジャロが安いおすすめクリニック8選' → its page): its entries are pages, not places; the card reads the list to its end, then those pages (the question's region only: an entry naming several regions is in each); not all read, the line says how many", async () => {
    const D = "https://dietarea.wpx.jp/";
    const LIST = `${D}mounjaro/`;
    const prefs = ["北海道", "青森", "岩手", "宮城", "秋田", "山形", "福島", "茨城", "栃木", "群馬", "埼玉", "千葉", "東京", "神奈川", "新潟", "富山", "石川", "福井", "山梨", "長野", "大阪", "京都・大阪・兵庫", "福岡", "沖縄", "中央区"];
    const art = (i: number) => `${D}r${String.fromCharCode(97 + i)}-mounjaro/`; // a word each, as the prefectures' romaji
    const region = (pref: string, i: number) => ({
      title: `${pref}でマンジャロが安いおすすめクリニック3選`,
      items: [0, 1, 2].map((k) => {
        const at = pref.split("・")[k] ?? pref;
        return { name: `${at}駅前クリニック${no(i)}-${k}`, key: `${at}駅前${no(i)}-${k}`, url: `https://c${i}-${k}.jp/`, text: `${at} · 2.5mg 3,000円` };
      }),
    });
    const pages = (list: Record<string, unknown>[]) => ({
      [LIST]: { title: "マンジャロ対応クリニック一覧【全国・都道府県別に検索】", items: list },
      ...Object.fromEntries(prefs.map((x, i) => [art(i), region(x, i)])),
    });
    const entries = prefs.map((x, i) => {
      const name = `${x}でマンジャロが安いおすすめクリニック3選！オンラインならもっと安い`;
      return { name, key: name, url: art(i) };
    });
    const about = { name: "運営者情報", key: "運営者情報", url: `${D}about/` };
    const site = siteReader(pages([...entries.slice(0, 12), about, ...entries.slice(12)]));
    // all of Japan: the list to its end (26 entries), then its 25 pages, one by one (中央区's too: no known region)
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, site.def, LIST);
    const all = await drawWith(t, site.def, []);
    expect(site.calls.slice(0, 2)).toEqual([{ url: LIST }, { url: LIST, itemsFrom: 20 }]);
    expect(site.calls.slice(2)).toEqual(prefs.map((_, i) => ({ url: art(i) })));
    expect(all.statuses).toContain(`${CARD_STATUS} · dietarea.wpx.jp 지역 페이지 1/25`);
    expect(t.drawn()).toMatchObject({ rows: 75 });
    expect(all.line).toBe("카드에 75곳 전부 정리했어요.");
    // Osaka: its page and the one naming it among others (the list's second part, with 中央区's), its places only
    const os = siteReader(pages([...entries.slice(0, 12), about, ...entries.slice(12, 19), entries[20]!, entries[24]!, entries[21]!]));
    const o = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "오사카에서 마운자로 처방받을 수 있는 클리닉 전부 찾아줘 카드로", card: ART });
    await modelRead(o, os.def, LIST);
    const osaka = await drawWith(o, os.def, []);
    expect(os.calls.slice(2)).toEqual([{ url: art(20) }, { url: art(21) }]);
    expect(o.drawn()).toMatchObject({ rows: 4 });
    expect(osaka.line).toBe("카드에 4곳 전부 정리했어요.");
    // a refusal on the third page: the site stops there
    const shut = siteReader(pages(entries.slice(0, 20)), { refuse: { [art(2)]: "blocked" } });
    const sh = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(sh, shut.def, LIST);
    const cut = await drawWith(sh, shut.def, []);
    expect(shut.calls).toHaveLength(4);
    expect(cut.line).toBe("카드에 6곳을 담았어요. 덜 읽은 정리 사이트: dietarea.wpx.jp(지역 페이지 20개 중 2개).");
    // no time left at the card (the turn began 5 minutes ago): none of its pages read, the line says so
    const none = siteReader(pages(entries.slice(0, 20)));
    const nt = new ExploreTracker({ cardReadGapMs: 0 }, Date.now() - 300_000, "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(nt, none.def, LIST);
    const late = await drawWith(nt, none.def, [["도쿄 (23구)", "공식 클리닉", "신주쿠", "¥9,800", "", "https://official-clinic.jp/", "공식 페이지"]]);
    expect(none.calls).toHaveLength(1);
    expect(late.line).toBe("카드에 1곳을 담았어요. 덜 읽은 정리 사이트: dietarea.wpx.jp(지역 페이지 20개 중 0개).");
    // no card to read on at: the answer's line says how many of its pages the model read
    const text = siteReader(pages(entries.slice(0, 20)));
    const tx = new ExploreTracker({}, Date.now(), "text", { text: ASK_ALL });
    await modelRead(tx, text.def, LIST);
    await modelRead(tx, text.def, art(0));
    expect(tx.cardLine()).toBe("덜 읽은 정리 사이트: dietarea.wpx.jp(지역 페이지 20개 중 1개).");
    // not such a list: round-ups on other sites, naming no region, about another drug, under half of the entries or
    // only two; the site's own clinic pages
    const clinics = Array.from({ length: 10 }, (_, i) => ({ name: `東京本院クリニック${no(i)}`, key: `東京本院${no(i)}`, url: `https://k${i}.jp/`, text: "東京 · 2.5mg 3,000円" }));
    for (const list of [
      entries.slice(0, 10).map((e, i) => ({ ...e, url: `https://other${i}.jp/osaka/` })),
      Array.from({ length: 10 }, (_, i) => ({ name: `マンジャロの副作用と安いおすすめクリニック${i + 3}選！オンラインならもっと安い`, key: `tips${i}`, url: `${D}tips${i}/` })),
      entries.slice(0, 10).map((e) => ({ name: e.name.replace("マンジャロ", "ウゴービ"), key: e.key.replace("マンジャロ", "ウゴービ"), url: e.url.replace("mounjaro", "wegovy") })),
      [...clinics, ...entries.slice(0, 4)],
      entries.slice(0, 2),
      Array.from({ length: 10 }, (_, i) => ({ name: `大阪梅田駅前クリニック${no(i)}`, key: `大阪梅田${no(i)}`, url: `${D}mounjaro/clinic/${i}/`, text: "大阪 · 2.5mg 3,000円" })),
    ]) {
      const r = siteReader(pages(list));
      const x = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
      await modelRead(x, r.def, LIST);
      await drawWith(x, r.def, [["도쿄 (23구)", "공식 클리닉", "신주쿠", "¥9,800", "", "https://official-clinic.jp/", "공식 페이지"]]);
      expect(r.calls).toHaveLength(1);
    }
  });

  test("'전부': a page of bare region names, each its own page on the site, is a hub with no count: its pages read at the card, those left named", async () => {
    // 2026-11-17: dietarea.wpx.jp/mounjaro/ listed 39 prefectures ('北海道', '青森県' … → /area/hokkaido/?drug=mounjaro), none
    // read, and the line said '카드에 1010곳 전부 정리했어요'
    const D = "https://dietarea.wpx.jp/";
    const INDEX = `${D}mounjaro/`;
    const prefs = ["北海道", "青森県", "東京都", "大阪府", "京都府", "福岡県", "沖縄県"];
    const area = (i: number) => `${D}area/p${"abcdefg"[i]}/?drug=mounjaro`;
    const index = { title: "マンジャロ対応クリニック一覧【全国・都道府県別に検索】", items: [...prefs.map((n, i) => ({ name: n, key: n, url: area(i) })), { name: "オンライン診療（全国）", key: "オンライン", url: `${D}area/online/?drug=mounjaro` }] };
    const clinics = (pref: string, i: number) => ({
      title: `${pref}のマンジャロ対応クリニック一覧【3院】`,
      items: [0, 1, 2].map((k) => ({ name: `${pref}クリニック${i}-${k}`, key: `${pref}${i}-${k}`, url: `${D}clinic/c${i}-${k}/`, text: `${pref} · 2.5mg 3,000円` })),
    });
    const pages = { [INDEX]: index, ...Object.fromEntries(prefs.map((x, i) => [area(i), clinics(x, i)])) };
    const site = siteReader(pages);
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, site.def, INDEX);
    const all = await drawWith(t, site.def, []);
    // its pages in its order, the online page too (an entry of the index all the same)
    expect(site.calls.slice(1)).toEqual([...prefs.map((_, i) => ({ url: area(i) })), { url: `${D}area/online/?drug=mounjaro` }]);
    expect(t.drawn()).toMatchObject({ rows: 21 });
    expect(all.line).toBe("카드에 21곳 전부 정리했어요.");
    // two pages that time out stop the site: the rest named, no '전부'
    const slow = siteReader(pages, { refuse: { [area(1)]: "timeout", [area(2)]: "timeout" } });
    const s2 = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(s2, slow.def, INDEX);
    const cut = await drawWith(s2, slow.def, []);
    expect(slow.calls).toHaveLength(4);
    expect(cut.line).toBe("카드에 3곳을 담았어요. 덜 읽은 정리 사이트: dietarea.wpx.jp(지역 페이지 8개 중 1개).");
    // a Korean directory's districts: the same
    const KO = "https://parking.example.kr/";
    const gu = ["강남구", "서초구", "송파구", "마포구", "종로구"];
    const koSite = siteReader({ [KO]: { title: "서울 공영주차장 구별 목록", items: gu.map((n, i) => ({ name: n, key: n, url: `${KO}gu/${i}` })) } });
    const ko = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "서울 공영주차장 전부 알려줘" });
    await modelRead(ko, koSite.def, KO);
    expect(ko.cardLine()).toBe("덜 읽은 정리 사이트: parking.example.kr(지역 페이지 5개 중 0개).");
    // not a hub: four region names only, a menu of other words beside them, or regions linking another site's pages
    const elsewhere = prefs.map((n, i) => ({ name: n, key: n, url: `https://map.example.com/jp/${i}` }));
    for (const items of [index.items.slice(0, 4), [...index.items.slice(0, 5), ...["会社概要", "お問い合わせ", "掲載基準", "運営者情報", "プライバシー", "サイトマップ"].map((n) => ({ name: n, key: n, url: `${D}${n}/` }))], elsewhere]) {
      const few = siteReader({ ...pages, [INDEX]: { ...index, items } });
      const f = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: ASK_ALL });
      await modelRead(f, few.def, INDEX);
      expect(f.cardLine()).toBeNull();
    }
  });

  test("hubs are read on the biggest first by the places they name (810 before 665, whatever order the model opened them); a list of region round-ups (no count) last", async () => {
    const SAYAKA = "https://sayaka-hub.jp/";
    // a second directory like mirai's naming more places; its clinics its own
    const sayaka = JSON.parse(
      JSON.stringify(miraiPages()).replaceAll(MIRAI, SAYAKA).replace("一覧665院", "一覧810院").replaceAll("クリニック", "医院").replaceAll("https://clinic", "https://sclinic").replaceAll("mlat=35.", "mlat=36."),
    ) as ReturnType<typeof miraiPages>;
    const D = "https://roundups.jp/";
    const LIST = `${D}mounjaro/`;
    const prefs = ["北海道", "宮城", "東京", "大阪"];
    const art = (i: number) => `${D}r${String.fromCharCode(97 + i)}-mounjaro/`;
    const articles = {
      [LIST]: { title: "マンジャロ対応クリニック一覧【都道府県別】", items: prefs.map((x, i) => ({ name: `${x}でマンジャロが安いおすすめクリニック3選`, key: `${x}3選`, url: art(i) })) },
      ...Object.fromEntries(
        prefs.map((x, i) => [art(i), { title: `${x}でマンジャロが安いおすすめクリニック3選`, items: [0, 1, 2].map((k) => ({ name: `${x}駅前院${no(i)}-${k}`, key: `${x}駅前${no(i)}-${k}`, url: `https://r${i}-${k}.jp/`, text: `${x} · 2.5mg 3,000円` })) }]),
      ),
    };
    const r = siteReader({ ...miraiPages(), ...sayaka, ...articles });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    // the model opens the round-ups first, then mirai, then the bigger one
    for (const u of [LIST, MIRAI, SAYAKA]) await modelRead(t, r.def, u);
    await drawWith(t, r.def, []);
    const firsts = r.calls.slice(3).filter((c) => !c.itemsFrom).map((c) => (c.url.startsWith(SAYAKA) ? "s" : c.url.startsWith(MIRAI) ? "m" : c.url.startsWith(D) ? "d" : "?"));
    expect([...new Set(firsts)].join("")).toBe("smd"); // begun in that order (three sites read at once)
    for (const x of ["s", "m"]) expect(firsts.filter((y) => y === x)).toHaveLength(47);
    expect(firsts.filter((x) => x === "d")).toHaveLength(4);
  });

  test("a parking list's rows: a monthly pass's entry (its page under '/monthly/', '월주차' in its name, '월' before its price) is priced by the month; an entry linking another kind's folder of the site (toilets, chargers by a lot) is no place of its list", async () => {
    const BS = "https://bluesquare.example.kr/parking/place/교보타워/";
    const DM = "https://dongne.example.kr/parking/역삼-강남구/";
    const GU = "서울특별시 강남구";
    const lots = Array.from({ length: 26 }, (_, i) => ({ name: `역삼${i}빌딩 주차장`, key: `역삼${i}빌딩`, url: `https://bluesquare.example.kr/parking/${5600 + i}/`, area: GU, text: `${i * 10}m, 1분 · 30분 ${3000 + i * 100}원` }));
    const pages = {
      [BS]: {
        title: "교보타워 주차장 30곳 요금, 거리 비교",
        items: [
          { name: "케이지페이먼츠 서울사무소", key: "케이지페이먼츠서울사무소", url: "https://bluesquare.example.kr/parking/74198/monthly/", area: GU, text: ", 약 1023m, 200000원" },
          { name: "강남N타워 월주차", key: "강남n타워월주차", url: "https://bluesquare.example.kr/parking/74199/", area: GU, text: "약 900m · 180,000원" },
          { name: "테헤란 오피스 주차장", key: "테헤란오피스", url: "https://bluesquare.example.kr/parking/74200/", area: GU, text: ", 약 800m, 월 210000원" },
          { name: "역삼 오피스텔 월주차", key: "역삼오피스텔월주차", url: "https://bluesquare.example.kr/parking/74201/monthly/", area: GU, text: "월 150,000원" },
          ...lots,
        ],
      },
      [DM]: {
        title: "역삼 — 서울 강남구 공영주차장 위치·요금",
        items: [
          ...Array.from({ length: 7 }, (_, i) => ({ name: `역삼${i}동 공영주차장`, key: `역삼${i}동공영`, url: `https://dongne.example.kr/parking/역삼${i}동-강남구/`, area: GU, text: `공영주차장 유료 · ${100 + i}m` })),
          ...["푸른솔도서관", "커피스미스빌딩", "감람교회"].map((n) => ({ name: n, key: n, url: `https://dongne.example.kr/toilet/${n}-강남구/`, area: GU, text: "공중화장실 · 88m" })),
          ...["서울강남 올림피아센터", "강남 대우디오빌플러스", "한라클래식오피스텔"].map((n) => ({ name: n, key: n, url: `https://dongne.example.kr/ev-charger/${n}-강남구/`, area: GU, text: "전기차 충전소 완속 · 90m" })),
          // one alone in another folder stays (a lot linked to its spot's page)
          { name: "역삼역 환승 주차장", key: "역삼역환승", url: "https://dongne.example.kr/place/역삼역-강남구/", area: GU, tel: "02-501-1234", text: "공영주차장 유료 · 210m" },
        ],
      },
    };
    const r = siteReader(pages);
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "서울 강남구 주차장 전부 카드로 보여줘", card: ART });
    for (const u of [BS, DM]) await modelRead(t, r.def, u);
    expect(t.listPlaces()).toBe(20 + 8); // the first 20 of 30, the 8 lots of 14 entries
    const { html } = await drawWith(t, r.def, []);
    expect(t.listPlaces()).toBe(30 + 8);
    // the card shows the amount, and under it what it is for ('월': by the month)
    for (const [name, amount] of [["케이지페이먼츠 서울사무소", "200000원"], ["강남N타워 월주차", "180,000원"], ["테헤란 오피스 주차장", "210000원"], ["역삼 오피스텔 월주차", "150,000원"]])
      expect([name, new RegExp(`<b>${name}</b>(?:(?!</li>).)*<b>${amount}</b><small>월</small>`).test(html)]).toEqual([name, true]);
    // apart from the lots' fees, as prices on another basis: the lowest and highest are the fees'
    expect(html).toMatch(/최저\s3000원\s·<\/span>\s<span class="n">최고\s5500원</);
    expect(html.indexOf("<b>케이지페이먼츠 서울사무소</b>")).toBeGreaterThan(html.indexOf("다른 기준 가격"));
    for (const name of ["역삼6동 공영주차장", "역삼역 환승 주차장"]) expect(html).toContain(name);
    for (const name of ["푸른솔도서관", "커피스미스빌딩", "감람교회", "올림피아센터", "대우디오빌플러스", "한라클래식오피스텔"]) expect([name, html.includes(name)]).toEqual([name, false]);
    // a page outside its entries' folder (the 구's page under '/parking/', its lots' under '/lot/'): its entries all stay
    const RG = "https://lots.example.kr/parking/gangnam/";
    const rg = siteReader({ [RG]: { title: "서울 강남구 주차장 12곳", items: Array.from({ length: 12 }, (_, i) => ({ name: `논현${i} 주차장`, key: `논현${i}`, url: `https://lots.example.kr/lot/${i}/`, area: GU, text: `30분 ${2000 + i}원` })) } });
    const g = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "서울 강남구 주차장 전부 카드로 보여줘", card: ART });
    await modelRead(g, rg.def, RG);
    expect(g.listPlaces()).toBe(12);
    // nor a page outside its lots' folder some of whose lots are elsewhere on the site (a partner's lots under '/partner/')
    const AR = "https://lots.example.kr/area/gangnam/";
    const ar = siteReader({ [AR]: { title: "서울 강남구 주차장 12곳", items: Array.from({ length: 12 }, (_, i) => ({ name: `신사${i} 주차장`, key: `신사${i}`, url: `https://lots.example.kr/${i < 9 ? "lot" : "partner"}/${i}/`, area: GU, tel: `02-544-${1000 + i}`, text: `30분 ${2000 + i}원` })) } });
    const ga = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "서울 강남구 주차장 전부 카드로 보여줘", card: ART });
    await modelRead(ga, ar.def, AR);
    expect(ga.listPlaces()).toBe(12);
  });

  test("nameFee / nameWalk: a parking fee at a list name's end is a price by its basis (the hour, minutes, the day, the month as '월'), its lot's hours and kind after it go with it; a walk at the end is apart; '제1호', '24시간', '3번 출구', '1층' stay in the name; a name holding another amount, or no name left, stays whole", () => {
    const split = (n: string) => {
      const f = nameFee(n);
      const w = nameWalk(f.name);
      return [w.name, f.price, w.walk];
    };
    for (const [name, want] of [
      // juchajucha (d29-p1/p3, d27-p1, d29-p2): the 'P' mark goes with the fee; '확인 필요' is no price
      ["P 한독약품빌딩 주차장 1시간 예상 요금 2,000원", ["한독약품빌딩 주차장", "2,000원 1시간", ""]],
      ["P 강남센타빌딩 31m · 걸어서 1분 1시간 예상 요금 6,000원", ["강남센타빌딩", "6,000원 1시간", "31m · 걸어서 1분"]],
      ["P 강남빌딩 유료민영주차장 127m · 걸어서 2분 1시간 예상 요금 확인 필요", ["강남빌딩 유료민영주차장", "", "127m · 걸어서 2분"]],
      ["P 1.5m 높이 제한 주차장 30분 1,000원", ["1.5m 높이 제한 주차장", "1,000원 30분", ""]],
      // bluesquare: the lot's hours and kind after the fee
      ["AC호텔바이메리어트 서울강남점 주차장 1시간 6,000원 24시간 민영", ["AC호텔바이메리어트 서울강남점 주차장", "6,000원 1시간", ""]],
      ["751빌딩 주차장 1시간 3,000원 민영", ["751빌딩 주차장", "3,000원 1시간", ""]],
      // by the month, the day, the hour in other words, minutes
      ["역삼 오피스텔 월정기권 120,000원", ["역삼 오피스텔", "월 120,000원", ""]],
      ["역삼 오피스텔 월주차 150,000원", ["역삼 오피스텔", "월 150,000원", ""]],
      ["강남 공영주차장 1일 20,000원", ["강남 공영주차장", "20,000원 1일", ""]],
      ["강남 공영주차장 하루 2만원", ["강남 공영주차장", "2만원 1일", ""]],
      ["강남 공영주차장 시간당 3,000원", ["강남 공영주차장", "3,000원 1시간", ""]],
      ["강남 공영주차장 10분 500원", ["강남 공영주차장", "500원 10분", ""]],
      // the name's own numbers stay
      ["역삼 제1호 공영주차장 1시간 2,400원", ["역삼 제1호 공영주차장", "2,400원 1시간", ""]],
      ["강남 24시간 주차장 1시간 예상 요금 3,000원", ["강남 24시간 주차장", "3,000원 1시간", ""]],
      ["역삼역 3번 출구 공영주차장 1시간 3,600원 공영", ["역삼역 3번 출구 공영주차장", "3,600원 1시간", ""]],
      ["테헤란빌딩 1층 주차장 30분 1,500원", ["테헤란빌딩 1층 주차장", "1,500원 30분", ""]],
      ["강남역12시간 주차장 1시간 1,000원", ["강남역12시간 주차장", "1,000원 1시간", ""]],
      ["역삼 공원 1.2km · 걸어서 15분", ["역삼 공원", "", "1.2km · 걸어서 15분"]],
    ] as const)
      expect([name, split(name)]).toEqual([name, [...want]]);
    // unchanged: no fee, a fee with no name before it, other words after it, another amount in the name, no basis
    for (const name of [
      "강남 24시간 주차장",
      "제1호 공영주차장",
      "역삼역 3번 출구 공영주차장",
      "테헤란빌딩 1층 주차장",
      "강남역 3번 출구 50m",
      "월정기권 70,000원",
      "P 1시간 예상 요금 3,000원",
      "1시간 3,600원 24시간 184면",
      "강남역 주차장 3시간 9,000원 할인",
      "강남 2,000원 주차장 1시간 3,000원",
      "강변 공영주차장 (성수) 3,000원운영 24시간",
      "대청역 1,200원",
      "근처 제휴, 예약 가능 케이지페이먼츠 서울사무소 약 637m, 월주차 200,000원, 자리 미리 확보",
      "387m · 걸어서 6분",
      "역삼 오피스텔 매월 100,000원", // '월' inside a word is no basis
      "123-4 1시간 3,000원", // no letter of a name left
    ])
      expect([name, split(name)]).toEqual([name, [name, "", ""]]);
  });

  test("nameFee / nameWalk on hostile names: one pass, no backtracking over digit or space runs (1 MB in well under a second)", () => {
    const MB = 1_000_000;
    const fill = (u: string) => u.repeat(Math.ceil(MB / u.length)).slice(0, MB);
    for (const name of [
      `빌딩 ${fill("1")}x`,
      `빌딩 1시간 ${fill("1")}x`,
      `빌딩 1시간${fill(" ")}x`,
      `빌딩 1시간 1${fill(",")}x`,
      `P 빌딩 주차장${fill(" 1시간 예상 요금 2,000원")}`,
      `빌딩 주차장 1시간 3,000원${fill(" 24시간 민영")}`,
      `${fill("1")}m · 걸어서 1분`,
      `빌딩 ${fill("1 ")}m · 걸어서 1분`,
    ]) {
      const t0 = performance.now();
      nameWalk(nameFee(name).name);
      expect([name.slice(0, 12), performance.now() - t0 < 500]).toEqual([name.slice(0, 12), true]);
    }
  });

  test("a parking list's rows: a fee written at an entry's name end is its price, by its basis (the hour first, minutes, the day and the month after '다른 기준 가격'); a walk at the end goes to the detail line; the entry's text price stays its price; same names on different lots stay two rows", async () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const JU = "https://juchajucha.example.kr/parking/gangnam";
    const names = [
      "P 한독약품빌딩 주차장 1시간 예상 요금 2,000원",
      "P 강남센타빌딩 31m · 걸어서 1분 1시간 예상 요금 6,000원",
      "P 역삼 제1호 공영주차장 1시간 예상 요금 2,400원",
      "P 강남 24시간 주차장 1시간 예상 요금 3,000원",
      "P 역삼역 3번 출구 공영주차장 1시간 예상 요금 3,600원",
      "P 현대주차장(민영) 1시간 예상 요금 4,000원",
      "P 현대주차장(민영) 1시간 예상 요금 5,000원",
      "P 리젠메디타워 주차장 1시간 예상 요금 4,500원",
      "P 테헤란빌딩 1층 주차장 30분 예상 요금 1,500원",
      "P 강남 공영주차장 1일 예상 요금 20,000원",
      "P 역삼 오피스텔 월정기권 120,000원",
      "P 강남빌딩 유료민영주차장 127m · 걸어서 2분 1시간 예상 요금 확인 필요",
    ];
    const items = names.map((n, i) => ({ name: n, key: n.replace(/[\s·,]/g, "").toLowerCase(), url: `https://juchajucha.example.kr/parking/${1000 + i}`, ...(i === 7 ? { text: "10분 1,000원" } : {}) }));
    const t = new ExploreTracker(undefined, Date.now(), "text", { text: "강남역 근처 주차장 전부 카드로 보여줘", card: { name: "sys_create_artifact", kind: "html" } });
    t.result(read, { ok: true, summary: "", data: { url: JU, title: "강남역 주차장 요금 | 주차주차", items, itemsTotal: items.length } });
    expect(t.listPlaces()).toBe(12);
    const { ctx, saved } = cardCtx();
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    expect((await rt.run({ rows: [], more: false }, ctx)).ok).toBe(true);
    expect(t.drawn()?.rows).toBe(12);
    const raw = saved.at(-1)?.content ?? "";
    const html = unglue(raw);
    const row = (name: string, rest = "") => new RegExp(`<b>${name.replace(/[()]/g, "\\$&")}</b>${rest}`);
    for (const [name, amount, unit] of [
      ["한독약품빌딩 주차장", "2,000원", "1시간"],
      ["역삼 제1호 공영주차장", "2,400원", "1시간"],
      ["강남 24시간 주차장", "3,000원", "1시간"],
      ["역삼역 3번 출구 공영주차장", "3,600원", "1시간"],
      ["테헤란빌딩 1층 주차장", "1,500원", "30분"],
      ["강남 공영주차장", "20,000원", "1일"],
      ["역삼 오피스텔", "120,000원", "월"],
    ])
      expect([name, row(name, `</div><span class="p"><b>${amount}</b><small>${unit}</small>`).test(html)]).toEqual([name, true]);
    expect(html).toMatch(row("리젠메디타워 주차장", `</div><span class="p"><b>1,000원</b></span>`)); // its text's price ('10분 1,000원', read as before), not its name's
    // the walk under the name (the card ties its '·' to the word before)
    expect(html).toMatch(row("강남센타빌딩", `<small>31m\u00a0· 걸어서 1분</small></div><span class="p"><b>6,000원</b><small>1시간</small>`));
    expect(html).toMatch(row("강남빌딩 유료민영주차장", `<small>127m\u00a0· 걸어서 2분</small></div></div></li>`)); // '확인 필요': no price
    // two lots of one name (other pages, other fees): two rows
    expect(html.match(/<b>현대주차장\(민영\)<\/b>/g)?.length).toBe(2);
    // the bracket glued to what it holds, a break box before it: no '주차장( / 민영)' (WebKit, keep-all)
    expect(raw.match(/<b>현대주차장<span class="t-brk"><\/span><span class="t-glue">\(민영\)<\/span><\/b>/g)?.length).toBe(2);
    for (const gone of ["예상 요금", "확인 필요", "<b>P ", "걸어서 1분 1시간"]) expect([gone, html.includes(gone)]).toEqual([gone, false]);
    // by the hour first (the most rows), the other bases after '다른 기준 가격', the lot with no price last
    const sep = html.indexOf("다른 기준 가격");
    expect(sep).toBeGreaterThan(0);
    for (const name of ["한독약품빌딩 주차장", "강남센타빌딩", "현대주차장(민영)"]) expect([name, html.indexOf(`<b>${name}</b>`) < sep]).toEqual([name, true]);
    for (const name of ["테헤란빌딩 1층 주차장", "강남 공영주차장", "역삼 오피스텔", "리젠메디타워 주차장", "강남빌딩 유료민영주차장"]) expect([name, html.indexOf(`<b>${name}</b>`) > sep]).toEqual([name, true]);
    expect(html.indexOf("<b>강남빌딩 유료민영주차장</b>")).toBeGreaterThan(html.indexOf("<b>역삼 오피스텔</b>"));
    expect(html).toMatch(/1시간\s기준\s최저\s2,000원\s·<\/span>\s<span class="n">최고\s6,000원</); // the hour's fees
  });

  test("a card that left list places off names them without the fee or walk their list wrote into the name", async () => {
    const read = { name: "web_read", explore: "read" } as unknown as ToolDef;
    const JU = "https://parking-list.jp/gangnam";
    const items = Array.from({ length: 17 }, (_, i) => {
      const n = `빌딩${String(i).padStart(2, "0")} 주차장`;
      return { name: i % 2 ? `P ${n} ${30 + i}m · 걸어서 1분 1시간 예상 요금 ${2 + i},000원` : `P ${n} 1시간 예상 요금 ${2 + i},000원`, key: `p${n}${i}`, url: `https://lot${i}.jp/` };
    });
    const t = new ExploreTracker(undefined, 0, "text", { text: "강남역 주차장 카드로", card: { name: "sys_create_artifact", kind: "html" } });
    t.result(read, { ok: true, summary: "", data: { url: JU, title: "강남역 주차장 요금 | 주차주차", items, itemsTotal: items.length } });
    const { ctx } = cardCtx();
    const rt = t.rowsTool(realArt())!;
    expect(t.takeLateCard("")).toBe(true);
    t.call(rt, "card_rows", {});
    await rt.run({ title: "강남역 주차장", rows: items.slice(0, 5).map((it) => ["강남", nameFee(it.name).name, "", "", "", it.url, ""]), more: true }, ctx);
    const left = Array.from({ length: 10 }, (_, i) => `빌딩${String(i + 5).padStart(2, "0")} 주차장`).join(", ");
    expect(t.cardLine()).toStartWith(`카드에 5곳을 담았어요. 시간 안에 받을 수 있는 만큼만 받아서, 카드에 넣지 못한 곳이 12곳 더 있어요: ${left} 외 2곳.`);
  });

  /** the index of the last entry that passes */
  const lastAt = <T,>(xs: readonly T[], f: (x: T) => boolean) => xs.reduce((at, x, i) => (f(x) ? i : at), -1);

  test("the card reads three sites at once, each site's pages one at a time (two directories of one site one after the other), in its order and CARD_READ_GAP_MS apart; the fourth site begins when one of them is done; a refusal stops its own site, the others read on", async () => {
    const hub = (host: string, n: number) =>
      JSON.parse(JSON.stringify(miraiPages()).replaceAll(MIRAI, host).replace("一覧665院", `一覧${n}院`).replaceAll("https://clinic", `https://c${n}-`).replaceAll("mlat=35.", `mlat=${n}.`)) as ReturnType<typeof miraiPages>;
    const [A, A2, B, C] = ["https://a-hub.jp/", "https://a-hub.jp/x/", "https://b-hub.jp/", "https://c-hub.jp/"];
    const r = siteReader({ ...hub(A, 900), ...hub(A2, 850), ...hub(B, 800), ...miraiPages(), ...hub(C, 600) }, { delayMs: 1, refuse: { [`${B}prefectures27/`]: "blocked" } });
    const run = r.def.run.bind(r.def);
    const now = new Map<string, number>();
    const at: { host: string; from?: number; t: number }[] = [];
    let most = 0;
    let mostSite = 0;
    (r.def as unknown as { run: (a: { url: string; itemsFrom?: number }, c: ToolContext) => ReturnType<ToolDef["run"]> }).run = async (a, c) => {
      const host = new URL(a.url).host;
      now.set(host, (now.get(host) ?? 0) + 1);
      mostSite = Math.max(mostSite, now.get(host)!);
      most = Math.max(most, [...now.values()].reduce((x, y) => x + y, 0));
      at.push({ host, ...(a.itemsFrom ? { from: a.itemsFrom } : {}), t: performance.now() });
      try {
        return await run(a, c);
      } finally {
        now.set(host, now.get(host)! - 1);
      }
    };
    const t = new ExploreTracker({ cardReadGapMs: 15 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    const fronts = [C, MIRAI, B, A2, A];
    for (const u of fronts) await modelRead(t, r.def, u);
    await drawWith(t, r.def, []);
    expect(most).toBe(3);
    expect(mostSite).toBe(1);
    const calls = r.calls.slice(fronts.length);
    const reads = (h: string) => calls.filter((c) => c.url.startsWith(h) && !c.itemsFrom).map((c) => c.url);
    for (const h of [A2, MIRAI, C]) expect([h, reads(h).length]).toEqual([h, 47]);
    expect(reads(A).length).toBe(47 * 2);
    expect(reads(B)).toEqual([`${B}prefectures13/`, `${B}prefectures27/`]); // refused at Osaka: its site stops there
    const begun = (h: string) => calls.findIndex((c) => c.url.startsWith(h));
    expect([begun(A) < begun(B), begun(B) < begun(MIRAI), begun(MIRAI) < begun(C)]).toEqual([true, true, true]);
    expect(begun(C)).toBeGreaterThan(lastAt(calls, (c) => c.url.startsWith(B)));
    expect(calls.findIndex((c) => c.url.startsWith(A2))).toBeGreaterThan(lastAt(calls, (c) => c.url.startsWith(A) && !c.url.startsWith(A2))); // its bigger one first
    // a site's region pages the gap apart (reading a page on, from the cache, follows it at once)
    for (const h of ["a-hub.jp", "c-hub.jp"]) {
      const ts = at.slice(fronts.length).filter((x) => x.host === h && !x.from).map((x) => x.t);
      expect(Math.min(...ts.slice(1).map((x, i) => x - ts[i]!))).toBeGreaterThanOrEqual(14);
    }
  });

  test("a page Exa's copy alone answered (it timed out or sent a 5xx) is read once more at the card's end, with time left: after every other page, a site's one at a time, the gap after its read before, once, from its start; its places reach the card", async () => {
    const LIST = "https://list.jarodb.kr/mounjaro";
    const long = { title: "마운자로 병원 목록", items: Array.from({ length: 30 }, (_, i) => ({ name: `리스트 클리닉 ${no(i)}`, key: `리스트${no(i)}`, url: `https://lc${i}.jp/`, text: "도쿄 · 9,000엔" })) };
    /**
     * the reader: these pages answer with Exa's copy alone (no list) the first time, or always; read once more: a refusal,
     * or slow. `at`: every call (`calls`: those the site answered)
     */
    const marking = (o: { once?: Record<string, string>; always?: Record<string, string>; refuseAgain?: string[]; slowAgainMs?: number; refuse?: Record<string, string> } = {}) => {
      const r = siteReader({ ...miraiPages(), [LIST]: long }, { refuse: o.refuse ?? {} });
      const run = r.def.run.bind(r.def);
      const seen = new Set<string>();
      const at: { url: string; from?: number; t: number }[] = [];
      (r.def as unknown as { run: (a: { url: string; itemsFrom?: number }, c: ToolContext) => ReturnType<ToolDef["run"]> }).run = async (a, c) => {
        at.push({ url: a.url, ...(a.itemsFrom ? { from: a.itemsFrom } : {}), t: performance.now() });
        const again = !a.itemsFrom && seen.has(a.url);
        if (!a.itemsFrom) seen.add(a.url);
        if (again && o.refuseAgain?.includes(a.url)) return { ok: false, summary: "읽지 못했어요", data: { error: "blocked", url: a.url } };
        if (again && o.slowAgainMs) {
          await new Promise<void>((done) => {
            const t = setTimeout(done, o.slowAgainMs);
            c.signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
          });
          if (c.signal?.aborted) return { ok: false, summary: "시간이 지났어요", data: { error: "timeout", url: a.url } };
        }
        const out = await run(a, c);
        const mark = o.always?.[a.url] ?? (again ? undefined : o.once?.[a.url]);
        if (!mark || a.itemsFrom || !out.ok) return out;
        return { ok: true, summary: "읽었어요", data: { url: a.url, title: (out.data as { title: string }).title, text: "", items: [], itemsTotal: 0, direct: mark, directWaitMs: 15_000 } };
      };
      return { ...r, at };
    };
    const base = siteReader({ ...miraiPages(), [LIST]: long });
    const b = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(b, base.def, MIRAI);
    const plain = await drawWith(b, base.def, []);
    expect(plain.line).toBe(`카드에 ${7 + 79}곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(665곳 중 ${7 + 79}곳).`);
    // Osaka timed out, Gifu (5 clinics) sent a 5xx; the list the model read sends a 5xx every time
    const r = marking({ once: { [pref(27)]: "timeout", [pref(21)]: "5xx" }, always: { [LIST]: "5xx" } });
    const t = new ExploreTracker({ cardReadGapMs: 15 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, r.def, LIST);
    await modelRead(t, r.def, MIRAI);
    const { statuses, line } = await drawWith(t, r.def, []);
    expect(r.calls.filter((c) => c.url === pref(27))).toEqual([{ url: pref(27) }, { url: pref(27) }, { url: pref(27), itemsFrom: 20 }]);
    expect(r.calls.filter((c) => c.url === pref(21))).toEqual([{ url: pref(21) }, { url: pref(21) }]);
    expect(r.calls.filter((c) => c.url === LIST)).toEqual([{ url: LIST }, { url: LIST }]); // once more, not again
    // after every other page of the directory, the gap after the site's read before
    const lastFirst = lastAt(r.calls, (c) => c.url.includes("/prefectures") && c.url !== pref(27) && c.url !== pref(21));
    for (const u of [pref(27), pref(21), LIST]) expect([u, lastAt(r.calls, (c) => c.url === u && !c.itemsFrom) > lastFirst]).toEqual([u, true]);
    const again = r.at.findIndex((x, i) => i > lastFirst && x.url === pref(27));
    const before = lastAt(r.at.slice(0, again), (x) => x.url.startsWith(MIRAI));
    expect(r.at[again]!.t - r.at[before]!.t).toBeGreaterThanOrEqual(14);
    expect(statuses).toContain(`${CARD_STATUS} · md.mirai-medical.clinic 다시 읽는 중`);
    // Osaka's and Gifu's clinics on the card as if they had answered at once
    expect(line).toBe(plain.line);
    // too little time left (CARD_REREAD_MIN_MS): no page is read again
    const short = marking({ once: { [pref(27)]: "timeout" } });
    const s = new ExploreTracker({ cardReadMs: 2_000, cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(s, short.def, MIRAI);
    await drawWith(s, short.def, []);
    expect(short.calls.filter((c) => c.url === pref(27))).toEqual([{ url: pref(27) }]);
    // a refusal when read once more stops its site: Gifu is not read again
    const no2 = marking({ once: { [pref(27)]: "timeout", [pref(21)]: "timeout" }, refuseAgain: [pref(27)] });
    const n = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(n, no2.def, MIRAI);
    const stop = await drawWith(n, no2.def, []);
    expect(no2.at.filter((c) => c.url === pref(27))).toHaveLength(2);
    expect(no2.at.filter((c) => c.url === pref(21))).toHaveLength(1);
    expect(stop.statuses.filter((x) => x.endsWith("다시 읽는 중"))).toHaveLength(1);
    // a page read once more is cut at its time (cardRereadMs): Exa's copy stays, the next page is read (that failure is
    // no site's: one page of it timed out before)
    const slow = marking({ once: { [pref(27)]: "timeout", [pref(21)]: "timeout" }, slowAgainMs: 400, refuse: { [pref(14)]: "timeout" } });
    const w = new ExploreTracker({ cardReadGapMs: 0, cardRereadMs: 40 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(w, slow.def, MIRAI);
    const t0 = performance.now();
    const cut = await drawWith(w, slow.def, []);
    expect(performance.now() - t0).toBeLessThan(400);
    expect(slow.at.filter((c) => c.url === pref(21))).toHaveLength(2);
    expect(cut.line).toBe(`카드에 ${7 + 79 - 29 - 5}곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(665곳 중 ${7 + 79 - 29 - 5}곳).`);
    // a page the page itself answered later (read on, or read anew) is not read again
    const later = marking();
    const l = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    l.result(later.def, { ok: true, summary: "", data: { url: LIST, title: long.title, items: [], itemsTotal: 0, direct: "timeout", directWaitMs: 8_000 } });
    await modelRead(l, later.def, LIST);
    await modelRead(l, later.def, MIRAI);
    await drawWith(l, later.def, []);
    expect(later.calls.filter((c) => c.url === LIST && !c.itemsFrom)).toHaveLength(1);
  });

  test("the directories seen and never opened are read at the card, the biggest first, each to its end; one that failed to open before is not tried again; one refused or not there now stays named as not seen; a small round-up is not read", async () => {
    const big = "https://big.example.jp/";
    const dir = "https://dir.example.jp/";
    const list = (tag: string, n: number) => ({ title: `일본 마운자로 병원 목록 ${n}곳`, items: Array.from({ length: n }, (_, i) => ({ name: `${tag}클리닉${no(i)}`, key: `${tag}${no(i)}`, url: `https://${tag}${i}.jp/`, text: "도쿄 · 9,000엔" })) });
    const r = siteReader({ [big]: list("big", 30), [dir]: list("dir", 12) }, { refuse: { "https://refused.example.jp/": "blocked" } });
    const search = { name: "web_search", explore: "search" } as unknown as ToolDef;
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    t.result(search, { ok: true, summary: "", data: { query: "마운자로", results: [
      { title: "일본 마운자로 병원 지도", url: "https://gone.example.jp/" },
      { title: "일본 마운자로 병원 지도", url: dir },
      { title: "일본 마운자로 병원 지도", url: "https://refused.example.jp/" },
      { title: "일본 마운자로 병원 지도", url: "https://missing.example.jp/" },
      { title: "일본 마운자로 추천 병원 5곳 비교", url: "https://small.example.jp/" },
      { title: "일본 마운자로 병원 300곳 지도", url: big },
    ] } });
    await modelRead(t, r.def, "https://gone.example.jp/"); // not there: a 404 the model met
    t.result(search, { ok: true, summary: "", data: { query: "마운자로 지도", results: [{ title: "일본 마운자로 병원 지도", url: "https://gone.example.jp/" }] } }); // seen again
    const { statuses, line } = await drawWith(t, r.def, []);
    // begun the biggest first (three sites at once), each to its end
    expect(r.calls[0]).toEqual({ url: "https://gone.example.jp/" });
    expect(r.calls.slice(1).filter((c) => !c.itemsFrom)).toEqual([{ url: big }, { url: dir }, { url: "https://refused.example.jp/" }, { url: "https://missing.example.jp/" }]);
    expect(r.calls.filter((c) => c.url === big)).toEqual([{ url: big }, { url: big, itemsFrom: 20 }]);
    expect(r.calls).toHaveLength(6);
    expect(statuses).toContain(`${CARD_STATUS} · big.example.jp 읽는 중`);
    expect(t.drawn()).toMatchObject({ rows: 42 });
    expect(line).toBe("카드에 42곳을 담았어요. 아직 안 본 정리 사이트: refused.example.jp, missing.example.jp, gone.example.jp.");
    // with a directory read in part too: the ones never opened first, then its region pages
    const both = siteReader({ ...miraiPages(), [big]: list("big", 30) });
    const bo = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    bo.result(search, { ok: true, summary: "", data: { query: "마운자로", results: [{ title: "일본 마운자로 병원 300곳 지도", url: big }] } });
    await modelRead(bo, both.def, MIRAI);
    await drawWith(bo, both.def, []);
    expect(both.calls.slice(1, 4)).toEqual([{ url: big }, { url: big, itemsFrom: 20 }, { url: pref(13) }]);
  });

  test("a directory's region pages: a refusal stops its site at once; the line says the places its title names and those read, or (none named, or all of them read) how many pages were read", async () => {
    const r = siteReader(miraiPages(), { refuse: { [pref(27)]: "blocked" } });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, r.def, MIRAI);
    const { line } = await drawWith(t, r.def, []);
    expect(r.calls.filter((c) => c.url.includes("/prefectures")).map((c) => c.url)).toEqual([pref(13), pref(13), pref(13), pref(27)]);
    expect(line).toBe(`카드에 ${7 + 45}곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(665곳 중 52곳).`);
    const slow = siteReader(miraiPages(), { delayMs: 30 });
    const s = new ExploreTracker({ cardReadMs: 100, cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(s, slow.def, MIRAI);
    const late = await drawWith(s, slow.def, []);
    expect(late.line).toMatch(/덜 읽은 정리 사이트: md\.mirai-medical\.clinic\(665곳 중 (\d+)곳\)\.$/);
    expect(Number(/중 (\d+)곳/.exec(late.line ?? "")?.[1]) < 7 + 79).toBe(true);
    // refused reading on a region page: the site stops there
    const mid = siteReader(miraiPages(), { refuse: { [`${pref(13)}@20`]: "rate_limited" } });
    const m = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(m, mid.def, MIRAI);
    const cut = await drawWith(m, mid.def, []);
    expect(mid.calls.filter((c) => c.url.includes("/prefectures"))).toEqual([{ url: pref(13) }, { url: pref(13), itemsFrom: 20 }]);
    expect(cut.line).toBe(`카드에 ${7 + 20}곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(665곳 중 27곳).`);
    // a timeout skips its page (never read again), the next ones are read; two stop the site. The front naming 80
    // (all of them read): the pages not read are said
    const few = () => ({ ...miraiPages(), [MIRAI]: { ...front, title: "全国のマンジャロが安いおすすめクリニック一覧80院" } });
    const flaky = siteReader(few(), { refuse: { [pref(14)]: "timeout" } });
    const f = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(f, flaky.def, MIRAI);
    const once = await drawWith(f, flaky.def, []);
    expect(flaky.calls.filter((c) => c.url === pref(14))).toHaveLength(1);
    expect(flaky.calls.filter((c) => c.url.includes("/prefectures") && !c.itemsFrom)).toHaveLength(47);
    expect(once.line).toContain("md.mirai-medical.clinic(지역 페이지 47개 중 46개)");
    // a region page whose read held none of its places (its prefecture menu as its list): not read
    const prefs = ["北海道", "青森県", "岩手県", "宮城県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県"];
    const okinawa = siteReader({ ...few(), [pref(47)]: { title: "沖縄のマンジャロおすすめクリニック一覧5院", items: prefs.map((name, i) => ({ name, key: `pref${i}`, url: pref(i + 1) })) } });
    const k = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(k, okinawa.def, MIRAI);
    const menuRead = await drawWith(k, okinawa.def, []);
    expect(menuRead.line).toBe(`카드에 ${7 + 79}곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(지역 페이지 47개 중 46개).`);
    const all = siteReader(few());
    const a = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(a, all.def, MIRAI);
    expect((await drawWith(a, all.def, [])).line).toBe(`카드에 ${7 + 79}곳 전부 정리했어요.`);
    // one failure on an open list's site, one on the directory's: the directory's other pages are still read
    const list = "https://list.jarodb.kr/mounjaro";
    const long = { title: "마운자로 병원 목록", items: Array.from({ length: 60 }, (_, i) => ({ name: `리스트 클리닉 ${no(i)}`, key: `리스트${no(i)}`, url: `https://lc${i}.jp/`, text: "도쿄 · 9,000엔" })) };
    const two = siteReader({ ...few(), [list]: long }, { refuse: { [`${list}@20`]: "timeout", [pref(14)]: "timeout" } });
    const b = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(b, two.def, list);
    await modelRead(b, two.def, MIRAI);
    await drawWith(b, two.def, []);
    expect(two.calls.filter((c) => c.url === list).map((c) => c.itemsFrom)).toEqual([undefined, 20]);
    expect(two.calls.filter((c) => c.url.includes("/prefectures") && !c.itemsFrom)).toHaveLength(47);
    const twice = siteReader(miraiPages(), { refuse: { [pref(14)]: "timeout", [pref(23)]: "timeout" } });
    const w = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(w, twice.def, MIRAI);
    await drawWith(w, twice.def, []);
    expect(twice.calls.filter((c) => c.url.includes("/prefectures") && !c.itemsFrom).map((c) => c.url)).toEqual([13, 27, 14, 23].map(pref));
    // a turn 4 minutes old reads nothing on (the server ends it at 5): the card holds what was read
    const old = siteReader(miraiPages());
    const o = new ExploreTracker({ cardReadGapMs: 0 }, Date.now() - CARD_READ_BY_MS, "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(o, old.def, MIRAI);
    const none = await drawWith(o, old.def, []);
    expect(old.calls).toHaveLength(1);
    expect(none.line).toBe("카드에 7곳을 담았어요. 덜 읽은 정리 사이트: md.mirai-medical.clinic(665곳 중 7곳).");
  });

  test("a question naming a region: only the places there count and reach the card, a directory's other prefectures are not read", async () => {
    const national = "https://list.jarodb.kr/mounjaro";
    const items = [
      // named for Tokyo, its area in Osaka
      { name: "東京美容外科", key: "東京美容外科", url: "https://tkc-osaka.jp/", area: "大阪市北区" },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `우메다 클리닉 ${no(i)}`, key: `우메다${no(i)}`, url: `https://u${i}.example.jp/`, text: `오사카 · 우메다 · ${8_000 + i}엔` })),
      ...Array.from({ length: 12 }, (_, i) => ({ name: `신주쿠 클리닉 ${no(i)}`, key: `신주쿠${no(i)}`, url: `https://s${i}.example.jp/`, text: `도쿄 · 신주쿠 · ${9_000 + i}엔` })),
      // a brand named for Tokyo, its Osaka branch
      { name: "東京美容外科 大阪梅田院", key: "東京美容外科大阪梅田院", url: "https://tkc.example.jp/umeda/" },
    ];
    const osakaOnly = { title: "오사카 마운자로 클리닉 모음", items: Array.from({ length: 9 }, (_, i) => ({ name: `닥터 ${no(i)} 클리닉`, key: `닥터${no(i)}`, url: `https://d${i}.example.jp/` })) };
    // the front's entry in a town no table knows, linking Osaka's page: in Osaka once the region pages are known
    const pages = miraiPages();
    pages[MIRAI] = { ...front, items: [...front.items, { name: "岬クリニック", key: "岬", url: pref(27), area: "泉南郡岬町", links: [{ url: "https://misaki-cl.jp/" }], text: "3,000円 /1本" }] };
    const r = siteReader({ ...pages, [national]: { title: "일본 마운자로 병원 목록", items }, "https://osaka.example.kr/list": osakaOnly });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "오사카에서 마운자로 처방받을 수 있는 클리닉 전부 찾아줘 카드로", card: ART });
    await modelRead(t, r.def, national);
    await modelRead(t, r.def, "https://osaka.example.kr/list");
    expect(t.listPlaces()).toBe(1 + 12 + 9); // the national list's first 20: 東京美容外科, Umeda's 12, Shinjuku's 7
    await modelRead(t, r.def, MIRAI);
    const { html, line } = await drawWith(t, r.def, []);
    expect(r.calls.filter((c) => c.url.includes("/prefectures") && !c.itemsFrom).map((c) => c.url)).toEqual([pref(27)]);
    // the directory's count is Osaka's page's (一覧33院), not its front's 665: 30 there and 岬 on the front
    expect(line).toContain("덜 읽은 정리 사이트: md.mirai-medical.clinic(33곳 중 31곳).");
    const names = namesOn(html);
    expect(names.filter((n) => n.startsWith("신주쿠"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("우메다 클리닉"))).toHaveLength(12);
    expect(names).toContain("東京美容外科 大阪梅田院"); // its 25th entry, read on at the card
    expect(names.filter((n) => n.startsWith("닥터"))).toHaveLength(9);
    expect(names).not.toContain("細川外科クリニック 名古屋市");
    expect(names.filter((n) => n.endsWith("(大阪市)"))).toHaveLength(29); // the 30th is the front's 森本
    expect(names).toContain("医療法人森本整形外科 大阪市");
    expect(names).toContain("東京美容外科");
    expect(names).toContain("岬クリニック");
    expect(html).not.toContain("<h3>기타");
    // two regions, one page naming no count: no count to hold the places to (and no page unread)
    const two = siteReader({ ...miraiPages(), [pref(13)]: { ...pages[pref(13)]!, title: "東京のマンジャロおすすめクリニック一覧300院" }, [pref(27)]: { ...pages[pref(27)]!, title: "大阪のマンジャロ クリニック" } });
    const tk = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "도쿄랑 오사카에서 마운자로 처방받을 수 있는 클리닉 전부 찾아줘 카드로", card: ART });
    await modelRead(tk, two.def, MIRAI);
    const both = await drawWith(tk, two.def, []);
    expect(two.calls.filter((c) => c.url.includes("/prefectures") && !c.itemsFrom).map((c) => c.url)).toEqual([pref(13), pref(27)]);
    expect(both.line).toMatch(/^카드에 \d+곳 전부 정리했어요\.$/);
    // '우리나라' names no region (나라 is one only standing alone): every region's places
    const k = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "우리나라 사람이 일본에서 마운자로 처방받을 수 있는 곳 전부 찾아줘 카드로", card: ART });
    await modelRead(k, r.def, national);
    expect(k.listPlaces()).toBe(20);
  });

  test("the notes: with the card drawing the lists, the model sends only what the lists lack, and leaves the lists begun to the card", async () => {
    const url = "https://list.jarodb.kr/mounjaro";
    const items = Array.from({ length: 60 }, (_, i) => ({ name: `클리닉 ${no(i)}`, key: `클리닉${no(i)}`, url: `https://c${i}.example.jp/`, text: "도쿄 · 9,000엔" }));
    const r = siteReader({ [url]: { title: "마운자로 병원 목록", items } });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    const rt = t.rowsTool(realArt(), r.def)!;
    expect(rt.description).toContain("읽은 목록에 나온 곳은 모시가 목록에서 넣어요");
    await modelRead(t, r.def, url);
    const progress = t.note(1_000, "progress");
    expect(progress).toContain(`시작한 목록의 나머지 항목(${url})은 모시가 카드를 만들 때 직접 읽어 넣어요`);
    expect(progress).not.toContain("열린 목록부터 끝까지 읽어요");
    expect(progress).not.toContain("아직 남은 목록·본문");
    expect(t.takeLateCard("")).toBe(true);
    const card = t.note(1_000, "card");
    expect(card).toContain("읽은 목록에 나온 곳은 모시가 그 목록에서 바로 카드에 넣어요");
    expect(card).toContain("이 목록의 곳은 모시가 목록에서 넣어요");
    expect(card).not.toContain("그곳들을 하나도 빼지 않고");
    expect(card).not.toContain("모두 한 행씩 넣어요");
    // without a reader: the lists' places are drawn, the lists begun are still the search's to read
    const n = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    n.rowsTool(realArt());
    await modelRead(n, r.def, url);
    expect(n.note(1_000, "progress")).toContain("열린 목록부터 끝까지 읽어요");
  });

  // a 동 주민센터 row: a phone of its own, its address in the text, 강남구 (its link, when given)
  const dongRow = (pre: string, i: number, url?: string) => ({
    name: `${pre}${no(i)}동 주민센터`,
    key: `${pre}${no(i)}동주민센터`,
    tel: `02-${3420 + "가나다라마".indexOf(pre)}-${7000 + i}`,
    area: "서울특별시 강남구",
    text: `02-${3420 + "가나다라마".indexOf(pre)}-${7000 + i} · 서울특별시 강남구 역삼로${i}길 16`,
    ...(url ? { url } : {}),
  });
  const menuPages = () => ({
    // a blog: 13 주민센터 with phones and one with a phone alone; 6 menu links to other sites (민원24 twice, '구민 소식' a
    // row of another list too): exactly 70% with a phone
    "https://blog.example.kr/461": {
      title: "강남구 동주민센터 위치 전화번호",
      items: [
        ...Array.from({ length: 13 }, (_, i) => dongRow("가", i)),
        { name: "강남 민원실", key: "강남민원실", tel: "02-3423-9999" },
        { name: "민원24", key: "민원24", url: "https://www.minwon.go.kr/", text: "등초본발급 · 주민등록 등초본 발급 및 열람" },
        { name: "민원24", key: "민원24", url: "https://www.minwon.go.kr/main.do", text: "바로가기" },
        { name: "구민 소식", key: "구민소식", url: "https://www.minwon.go.kr/news" },
        { name: "노인복지", key: "노인복지", url: "https://www.gangnam.go.kr/board/senior_support/list.do", text: "기초연금 지원 · 바로가기" },
        { name: "아이사랑보육포털", key: "아이사랑보육포털", url: "https://www.childcare.go.kr/parents/content_10147.jsp", text: "보육료 지원 · (보건복지부)" },
        { name: "저소득 한부모가정 신청접수 및 지원", key: "저소득한부모가정신청접수및지원", url: "https://www.gangnam.go.kr/board/livelihood_support/list.do", text: "바로가기" }, // '… 지원' is no branch
      ],
    },
  });
  const menuAsk = "강남구 주민센터 전부 알려줘 카드로";

  test("a list whose rows mostly have a phone (70%) leaves out its menu rows; a phoneless row with a sign of a place stays; the count by site is the run's", async () => {
    const site = (i: number) => `https://www.gangnam.go.kr/center/main.do?office=${3220000 + i}`;
    const keep = (name: string, more: Record<string, unknown>) => ({ name, key: name.replace(/\s/g, ""), url: `https://${encodeURIComponent(name).length}x${name.length}.example.kr/`, ...more });
    const pages = {
      ...menuPages(),
      // 14 with phones, 6 without and each with a sign: exactly 70%
      "https://info.example.kr/gangnam": {
        title: "강남구 주민센터 안내",
        items: [
          ...Array.from({ length: 14 }, (_, i) => dongRow("나", i, site(i))),
          keep("개포 쉼터", { text: "개포로 303 지도보기" }),
          keep("대치 쉼터", { text: "대치동 123-4" }),
          keep("Yeoksam Hall", { text: "823-19 Yeoksam-dong, KR" }),
          keep("열린 쉼터", { text: "Restaurant · Address · Seoul, KR" }),
          keep("도곡 열람실", { text: "평일 09:00-18:00" }),
          keep("수서 체육관", { text: "1회 3,000원" }),
        ],
      },
      // 14 with phones (one links its site's front folder), 4 with a sign, 2 menu rows: exactly 70%
      "https://info2.example.kr/gangnam": {
        title: "강남구 주민센터 전화번호",
        items: [
          ...Array.from({ length: 13 }, (_, i) => dongRow("다", i, site(100 + i))),
          dongRow("다", 13, "https://www.gangnam.go.kr/dong13"),
          keep("모시 강남점", {}),
          { name: "세곡 쉼터", key: "세곡쉼터", url: site(999) }, // the folder the rows with phones link to
          keep("삼성 문화센터", {}),
          keep("일원 사랑방", { contacts: [{ kind: "kakao", value: "ilwon" }] }),
          { name: "공지사항", key: "공지사항", url: "https://www.gangnam.go.kr/board/notice/list.do", text: "바로가기" },
          { name: "새소식", key: "새소식", url: "https://www.gangnam.go.kr/news" }, // the front folder is none
        ],
      },
      "https://info3.example.kr/gangnam": {
        title: "강남구 주민센터 연락처",
        items: [
          ...Array.from({ length: 14 }, (_, i) => dongRow("마", i)),
          keep("논현 쉼터", { area: "서울특별시 강남구" }),
          keep("역삼 쉼터", { text: "문의 02-555-1234" }),
          keep("우메다 쉼터", { text: "大阪市北区梅田1-2" }),
        ],
      },
      // 6 of 9 with a phone (67%): every row stays
      "https://few.example.kr/gangnam": {
        title: "강남구 주민센터 목록",
        items: [
          ...Array.from({ length: 6 }, (_, i) => dongRow("라", i)),
          { name: "구민 소식", key: "구민소식", url: "https://few2.example.kr/news" },
          { name: "웹 접근성 안내", key: "웹접근성안내", url: "https://few2.example.kr/a11y" },
          { name: "개인정보처리방침", key: "개인정보처리방침", url: "https://few2.example.kr/privacy" },
        ],
      },
    };
    const r = siteReader(pages);
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: menuAsk, card: ART });
    for (const url of Object.keys(pages)) await modelRead(t, r.def, url);
    expect(t.listPlaces()).toBe(14 + 20 + 18 + 17 + 9);
    const { html } = await drawWith(t, r.def, []);
    const names = namesOn(html);
    for (const gone of ["민원24", "노인복지", "아이사랑보육포털", "저소득 한부모가정 신청접수 및 지원", "공지사항", "새소식"]) expect(names).not.toContain(gone);
    for (const kept of ["강남 민원실", "개포 쉼터", "대치 쉼터", "Yeoksam Hall", "열린 쉼터", "도곡 열람실", "수서 체육관", "모시 강남점", "세곡 쉼터", "삼성 문화센터", "일원 사랑방", "논현 쉼터", "역삼 쉼터", "우메다 쉼터", "구민 소식", "웹 접근성 안내", "개인정보처리방침"])
      expect(names).toContain(kept);
    expect(names).toHaveLength(78);
    expect(t.drawn()!.menu).toEqual({ "blog.example.kr": 4, "info2.example.kr": 2 });
    // the asked noun keeps a row too ('…학원' among academies with phones)
    const academies = {
      "https://hagwon.example.kr/daechi": {
        title: "대치동 학원 목록",
        items: [
          ...Array.from({ length: 9 }, (_, i) => ({ name: `대치 ${no(i)} 아카데미`, key: `대치${no(i)}아카데미`, tel: `02-555-${1000 + i}`, url: `https://a${i}.example.kr/` })),
          { name: "대치청연학원", key: "대치청연학원", url: "https://cy.example.kr/" },
          { name: "입시 설명회 안내", key: "입시설명회안내", url: "https://notice.example.kr/" },
        ],
      },
    };
    const a = siteReader(academies);
    const ta = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "대치동 학원 전부 알려줘 카드로", card: ART });
    await modelRead(ta, a.def, "https://hagwon.example.kr/daechi");
    const academy = namesOn((await drawWith(ta, a.def, [])).html);
    expect(academy).toContain("대치청연학원");
    expect(academy).not.toContain("입시 설명회 안내");
    expect(ta.drawn()!.menu).toEqual({ "hagwon.example.kr": 1 });
    // no menu row: no count
    const plain = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: menuAsk, card: ART });
    await modelRead(plain, r.def, "https://few.example.kr/gangnam");
    await drawWith(plain, r.def, []);
    expect(plain.drawn()!.rows).toBe(9);
    expect(plain.drawn()!.menu).toBeUndefined();
  });

  test("in the loop: the menu rows left out are logged once by site, counts only", async () => {
    const r = siteReader(menuPages());
    const url = "https://blog.example.kr/461";
    const wide = createRunTurn(llm, { deepSearch: { exhaustive: { calls: 6, minQueries: 3, minCalls: 0 }, cardReadGapMs: 0 } });
    const answer = "강남구 주민센터는 14곳이에요. 전체는 이어서 카드로 보여 드려요.";
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "강남구 주민센터" }), call("b", "web_search", { query: "강남구 동주민센터 전화" }), call("c", "web_search", { query: "강남구청 주민센터 안내" })] },
      { toolCalls: [call("r", "web_read", { url })] },
      { text: [answer] },
      { toolCalls: [call("rows", "card_rows", { title: "강남구 주민센터", rows: [], more: false })] },
    );
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const { ctx, saved } = cardCtx();
      const { outcome } = await run(wide, "강남구 주민센터 전부 알려줘 카드로", { tools: [webSearch, r.def, realArt()] as unknown as ToolDef[], ctx });
      expect(namesOn(saved[0]!.content)).toHaveLength(14); // '구민 소식' with no other list read: a menu row
      expect(outcome.text).toBe(`${answer}\n\n카드에 14곳 전부 정리했어요.`);
      expect(info.mock.calls).toEqual([["[pickle/agent] card menu rows left out blog.example.kr=5"]]);
    } finally {
      info.mockRestore();
    }
  });

  test("a row named by a button's or a menu's words alone is no place, phone or not; a word left over or an address in its text keeps it", async () => {
    const button = (name: string, i: number, more: Record<string, unknown> = {}) => ({ name, key: name.replace(/\s/g, ""), url: `https://b${i}.example.kr/go`, ...more });
    const keep = (name: string, i: number) => ({ name, key: name.replace(/\s/g, ""), url: `https://k${i}.example.kr/`, tel: `02-777-${1000 + i}` });
    const pages = {
      "https://list.example.kr/gangnam": {
        title: "강남구 주민센터 목록",
        items: [
          ...Array.from({ length: 10 }, (_, i) => dongRow("가", i)),
          // saved runs' (2026-11-11 to 11-17): kireihc, japannetclinic, coolitlab (a phone of its page), dongnescore, a blog's category
          ...["予約ページを見る", "アクセス", "카카오맵", "Book. (41)", "찾아오시는 길", "LINEから予約 LINEから予約", "사이트맵", "地図", "もっと見る", "예약 페이지"].map((n, i) => button(n, i)),
          button("📞 전화번호", 20, { tel: "02-2155-7290", text: ": 02-2155-7290" }),
          button("대표전화 1566-0025", 21, { tel: "1566-0025" }),
          button("오시는 길", 22, { text: "서울특별시 강남구 역삼로 12 · 역삼역 3번 출구" }), // an address: a place under its link's name
          keep("광화문 전화국", 1),
          keep("Book Cafe 역삼", 2),
          keep("예약 없는 역삼 쉼터", 3),
          keep("지도 박물관", 4),
          keep("더 홈", 5), // no button's word in it, though each word could sit on one
        ],
      },
    };
    const r = siteReader(pages);
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: menuAsk, card: ART });
    await modelRead(t, r.def, "https://list.example.kr/gangnam");
    expect(t.listPlaces()).toBe(10); // the first 20 rows: 10 buttons
    const names = namesOn((await drawWith(t, r.def, [])).html); // the card reads the rest
    expect(t.listPlaces()).toBe(16);
    expect(names).toHaveLength(16);
    for (const kept of ["광화문 전화국", "Book Cafe 역삼", "예약 없는 역삼 쉼터", "지도 박물관", "더 홈", "오시는 길"]) expect(names).toContain(kept);
    expect(t.drawn()!.menu).toBeUndefined(); // no menu row: a button is not counted among the list's rows
  });

  test("in the loop: the card's last page reads the list begun on with the turn's page reader, and the line counts the card", async () => {
    const url = "https://list.jarodb.kr/mounjaro";
    const items = Array.from({ length: 60 }, (_, i) => ({ name: `클리닉 ${no(i)}`, key: `클리닉${no(i)}`, url: `https://clinic${i}.jp/`, text: `도쿄 · 역 앞 · ${9_000 + i}엔` }));
    const r = siteReader({ [url]: { title: "일본 마운자로 병원 60곳", items } });
    const wide = createRunTurn(llm, { deepSearch: { exhaustive: { calls: 6, minQueries: 3, minCalls: 0 }, cardReadGapMs: 0 } });
    const answer = "도쿄에서 9,000엔부터예요. 전체 목록은 이어서 카드로 보여 드려요.";
    mock.script.push(
      { toolCalls: [call("a", "web_search", { query: "일본 마운자로 처방" }), call("b", "web_search", { query: "マンジャロ 処方" }), call("c", "web_search", { query: "mounjaro japan" })] },
      { toolCalls: [call("r", "web_read", { url })] },
      { text: [answer] },
      { toolCalls: [call("rows", "card_rows", { title: "일본 마운자로 클리닉", rows: [], more: false })] },
    );
    const { ctx, saved } = cardCtx();
    const { outcome } = await run(wide, "일본 마운자로 처방받을 수 있는 클리닉 전부 찾아줘 카드로", { tools: [webSearch, r.def, realArt()] as unknown as ToolDef[], ctx });
    expect(r.calls).toEqual([{ url }, { url, itemsFrom: 20 }, { url, itemsFrom: 40 }]);
    expect(saved).toHaveLength(1);
    expect(namesOn(saved[0]!.content)).toHaveLength(60);
    expect(outcome.text).toBe(`${answer}\n\n카드에 60곳 전부 정리했어요.`);
    expect((ctx as unknown as { statuses: string[] }).statuses).toContain(`${CARD_STATUS} · list.jarodb.kr 목록 21번째부터`); // the turn's status line
    // the model was told the list's rest is the card's to read, and what rows to send
    expect(mock.requests.map((q) => q.body.messages.at(-1)!.content).join("\n")).toContain("모시가 카드를 만들 때 직접 읽어 넣어요");
    expect(lastUser(mock.requests.length - 1)).toContain("읽은 목록에 나온 곳은 모시가 그 목록에서 바로 카드에 넣어요");
  });

  test("groups: a list place joins the model's group in its prefecture, else its prefecture's ('아이치(나고야)'); online care its own", async () => {
    const url = "https://list.jarodb.kr/mounjaro";
    const items = [
      { name: "細川外科クリニック 名古屋市", key: "細川外科名古屋市", url: "https://www.hosoge.com/", area: "名古屋市" },
      { name: "豊橋クリニック", key: "豊橋", url: "https://toyohashi-cl.jp/", area: "愛知県豊橋市" },
      { name: "ひろしまクリニック", key: "ひろしま", url: "https://hiroshima-cl.jp/", area: "広島市" },
      { name: "台東クリニック", key: "台東", url: "https://taito-cl.jp/", area: "台東区" },
      { name: "高崎クリニック", key: "高崎", url: "https://takasaki-cl.jp/", area: "高崎市" },
      { name: "神戸三宮クリニック", key: "神戸三宮", url: "https://kobe-cl.jp/", text: "三宮 · 5,000円" },
      { name: "オンライン診療クリニック", key: "オンライン診療", url: "https://online-cl.jp/", area: "オンライン" },
      { name: "どこかクリニック", key: "どこか", url: "https://dokoka-cl.jp/" },
      { name: "浜松町クリニック", key: "浜松町", url: "https://hamamatsucho-cl.jp/", area: "港区浜松町" }, // Tokyo's, not 浜松's
      { name: "東京美容外科 大阪梅田院", key: "東京美容外科大阪梅田院", url: "https://tkc-umeda.jp/" }, // its branch, not its brand
      { name: "고분 클리닉", key: "고분", url: "https://kofun-cl.jp/", area: "나라시 산조" }, // 나라 before 시
    ];
    const r = siteReader({ [url]: { title: "일본 마운자로 병원 목록", items } });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, r.def, url);
    const { html } = await drawWith(t, r.def, [
      ["나고야", "공식 나고야 클리닉", "사카에", "¥9,800", "", "https://nagoya-official.jp/", "공식 페이지"],
      ["도쿄", "공식 도쿄 클리닉", "신주쿠", "¥9,800", "", "https://tokyo-official.jp/", "공식 페이지"],
    ]);
    const groups = Object.fromEntries([...html.matchAll(/<h3>([^<]*)<span>(\d+)곳/g)].map((m) => [m[1]!, Number(m[2])]));
    expect(groups).toEqual({ 나고야: 3, 도쿄: 3, 히로시마: 1, 군마: 1, "효고(고베)": 1, 온라인: 1, 기타: 1, 오사카: 1, 나라: 1 });
  });

  test("a directory whose entries link only their own pages reads none of them; one place on two lists under two keys is one row; with the card reading lists on, a list begun holds no gate", async () => {
    const hub = "https://all-clinics.jp/";
    const detail = { title: "全国のマンジャロクリニック一覧300院", items: Array.from({ length: 10 }, (_, i) => ({ name: `全国クリニック${no(i)}`, key: `全国${no(i)}`, url: `${hub}clinic/${i + 1}/`, area: "東京都新宿区" })) };
    const r = siteReader({ [hub]: detail });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, r.def, hub);
    const { line } = await drawWith(t, r.def, []);
    expect(r.calls).toHaveLength(1);
    expect(line).toBe("카드에 10곳을 담았어요. 덜 읽은 정리 사이트: all-clinics.jp(300곳 중 10곳).");
    // twins under two keys, on two lists: one row each, and the line says all
    const a = "https://list-a.jp/";
    const b = "https://list-b.jp/";
    const names = Array.from({ length: 12 }, (_, i) => `쌍둥이 클리닉 ${no(i)}`);
    const two = siteReader({
      [a]: { title: "마운자로 병원 목록", items: names.map((n, i) => ({ name: n, key: `a${i}`, url: `https://twin${i}.jp/`, text: "도쿄 · 9,000엔" })) },
      [b]: { title: "마운자로 병원 목록", items: names.map((n, i) => ({ name: `${i + 1}. ${n} ▶`, key: `b${i}`, url: `https://other${i}.jp/` })) },
    });
    const u = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(u, two.def, a);
    await modelRead(u, two.def, b);
    expect(u.listPlaces()).toBe(12);
    const both = await drawWith(u, two.def, []);
    expect(namesOn(both.html)).toHaveLength(12);
    expect(both.line).toBe("카드에 12곳 전부 정리했어요.");
    // the gate: a list begun is the card's to read on, so it holds no answer back; without a reader it does
    const search = { name: "web_search", explore: "search" } as unknown as ToolDef;
    const url = "https://list.jarodb.kr/mounjaro";
    const long = { title: "마운자로 병원 목록", items: Array.from({ length: 60 }, (_, i) => ({ name: `클리닉 ${no(i)}`, key: `클리닉${no(i)}`, url: `https://clinic${i}.jp/` })) };
    for (const withReader of [true, false]) {
      const g = siteReader({ [url]: long });
      const q = new ExploreTracker({ exhaustive: { calls: 40, minQueries: 1, minTools: 2, minCalls: 0 }, cardReadGapMs: 0 }, Date.now(), "text", { text: "일본 마운자로 처방받을 수 있는 클리닉 전부 찾아줘 카드로", card: ART });
      q.rowsTool(realArt(), withReader ? g.def : undefined);
      q.call(search, "web_search", { query: "일본 마운자로 처방" });
      q.result(search, { ok: true, summary: "", data: { results: [] } });
      await modelRead(q, g.def, url);
      expect(q.gateMet()).toBe(withReader);
    }
  });

  test("a list about something else than the question's drug (a hospital finder) holds no places: none drawn, none read on, none in the line; a list naming the drug in its address or GLP-1 care, or on a site with a list about it, does; article links are not places; a search provider's page is no round-up", async () => {
    const finder = "https://www.doctor-map.info/osaka/";
    const hospitals = { title: "病院を病院名で検索／ホームメイト", items: Array.from({ length: 60 }, (_, i) => ({ name: `あべの歯科クリニック${no(i)}`, key: `あべの歯科${no(i)}`, url: `https://dent${i}.jp/`, area: "大阪市阿倍野区" })) };
    const own = "https://list.jarodb.kr/osaka";
    const clinics = {
      title: "오사카 마운자로 병원 목록",
      items: [
        ...Array.from({ length: 10 }, (_, i) => ({ name: `우메다 클리닉 ${no(i)}`, key: `우메다${no(i)}`, url: `https://u${i}.jp/`, text: "오사카 · 우메다 · 9,000엔" })),
        // the list's related posts
        { name: "【2026年最新】山科のマンジャロ処方おすすめクリニック6選|料金比較", key: "山科マンジャロ処方おすすめ6選料金比較", url: "https://list.jarodb.kr/yamashina/" },
        { name: "大阪でマンジャロが安いおすすめクリニック7選!オンラインなら通院不要?", key: "大阪マンジャロ安いおすすめ7選", url: "https://list.jarodb.kr/osaka-7/" },
        // an operator column: a company, not a place; a clinic's own corporation is one
        { name: "合同会社DMM.com", key: "合同会社dmmcom", url: "https://clinic.dmm.com/" },
        { name: "レバレジーズ株式会社", key: "レバレジーズ株式会社", url: "https://levaclinic.jp/" },
        { name: "大阪梅田クリニック（運営 株式会社ウメダ）", key: "大阪梅田", url: "https://osaka-umeda-cl.jp/", text: "오사카 · 우메다 · 12,000엔" },
      ],
    };
    const pages = { [finder]: hospitals, [own]: clinics };
    const r = siteReader(pages);
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "오사카에서 마운자로 처방받을 수 있는 클리닉 전부 찾아줘 카드로", card: ART });
    await modelRead(t, r.def, finder);
    await modelRead(t, r.def, own);
    expect(t.listPlaces()).toBe(11);
    const { html, line } = await drawWith(t, r.def, []);
    expect(r.calls.filter((c) => c.url === finder)).toEqual([{ url: finder }]); // never read on
    const names = namesOn(html);
    expect(names).toHaveLength(11);
    expect(names.filter((n) => n.includes("歯科") || n.includes("選") || n.includes("会社"))).toEqual(["大阪梅田クリニック(運営 株式会社ウメダ)"]); // its name in NFKC, as listName gives it
    expect(line).toBe("카드에 11곳 전부 정리했어요.");
    expect(t.note(1_000, "progress")).not.toContain("doctor-map");
    // a question naming no drug: the finder's hospitals are places
    const plain = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: "오사카 치과 전부 찾아줘 카드로", card: ART });
    await modelRead(plain, siteReader(pages).def, finder);
    expect(plain.listPlaces()).toBe(20);
    // the drug in the address, GLP-1 care in the title, or a site with a list about the drug: on topic
    const byUrl = "https://navi.jp/%E3%83%9E%E3%83%B3%E3%82%B8%E3%83%A3%E3%83%AD/osaka/"; // /マンジャロ/osaka/
    const glp = "https://glp.jp/list";
    const sub = "https://list.jarodb.kr/fukuoka-8";
    const sushi = "https://xn--2o2b11q2e68p.site/";
    const more = siteReader({
      [sushi]: { title: "스시자로 병원 지도", items: Array.from({ length: 8 }, (_, i) => ({ name: `스시 클리닉 ${no(i)}`, key: `스시${no(i)}`, url: `https://s${i}.jp/` })) },
      [byUrl]: { title: "大阪のクリニック一覧", items: Array.from({ length: 8 }, (_, i) => ({ name: `ナビクリニック${no(i)}`, key: `ナビ${no(i)}`, url: `https://navi${i}.jp/` })) },
      [glp]: { title: "GLP-1ダイエット 大阪の病院", items: Array.from({ length: 8 }, (_, i) => ({ name: `GLPクリニック${no(i)}`, key: `glp${no(i)}`, url: `https://g${i}.jp/` })) },
      [sub]: { title: "후쿠오카 병원 8곳", items: Array.from({ length: 8 }, (_, i) => ({ name: `후쿠 클리닉 ${no(i)}`, key: `후쿠${no(i)}`, url: `https://f${i}.jp/` })) },
      [own]: clinics,
    });
    const m = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(m, more.def, sub);
    expect(m.listPlaces()).toBe(0); // a site with nothing about the drug yet
    for (const u of [byUrl, glp, sushi, own]) await modelRead(m, more.def, u);
    expect(m.listPlaces()).toBe(8 + 8 + 8 + 8 + 11);
    // a search provider's page among the results: never a site to read
    const search = { name: "web_search", explore: "search" } as unknown as ToolDef;
    m.result(search, { ok: true, summary: "", data: { results: [{ title: "大阪 マンジャロ クリニック 一覧 85院", url: "https://exa.ai/search?q=medidietmap" }] } });
    expect(m.roundups().map((x) => x.url).filter((u) => u.includes("exa.ai"))).toEqual([]);
  });

  test("one clinic in lists of two styles or scripts counts once: a city after its name, glued or bracketed, a doubled name, another script's name in brackets or in its text, and a list linking both, a branch word with or without 원 or the prefecture's name, 덴 for 텐; in one city and prefecture; two bracketed names never match each other, a bracket names one place only, a branch in the name's own script stays; an entry named by its link is no place", async () => {
    const fill = (host: string, n: number) => Array.from({ length: n }, (_, i) => ({ name: `${host} クリニック ${no(i)}`, key: `${host}${no(i)}`, url: `https://${host}${i}.jp/` }));
    // a directory writing the city after the name (glued, or in brackets on its other pages)
    const navi = "https://jp-clinic-navi.jp/mounjaro/";
    // another writing the name twice and the city after; its entries carry their addresses
    const biyou = "https://biyou-navi.jp/mounjaro/";
    // a Korean list, Korean names only
    const excel = "https://excel.example.kr/mounjaro";
    // a Korean round-up: the Japanese name in brackets, or in the entry's text
    const ko = "https://list.jarodb.kr/mounjaro";
    // a Japanese list read last
    const jp2 = "https://online-navi.jp/mounjaro/";
    const pages = {
      [navi]: {
        title: "マンジャロ処方クリニック一覧",
        items: [
          { name: "やまもと内科クリニック広島市", key: "やまもと内科クリニック広島市", url: "https://yamamoto-naika-clinic.com/", area: "広島市" },
          { name: "やまもと内科クリニック福山市", key: "やまもと内科クリニック福山市", url: "https://yamamoto-fukuyama.jp/", area: "福山市" },
          { name: "ありずみ消化器内科(大阪市)", key: "ありずみ消化器内科大阪市", url: "https://arizumi.jp/", area: "大阪市" },
          { name: "さくら内科クリニック(札幌市)", key: "さくら内科札幌市", url: "https://sakura-sapporo.jp/", area: "札幌市" },
          { name: "整形外科 ぐんまの森クリニック高崎市", key: "整形外科ぐんまの森クリニック高崎市", url: "https://www.gunmanomori-clinic.jp/", area: "高崎市" },
          // a city in brackets after a name with no kind word
          { name: "Ｍａｓｔ Ｂｅａｕｔｙ(港区)", key: "mastbeauty港区", url: "https://mbcl.co.jp/", area: "港区" },
          // a list number and arrow: the same name as biyou's (no form: 'mbd' is too short to match by)
          { name: "14. MBDクリニック ▶", key: "14mbd▶", url: "https://mbd.jp/", area: "東京都渋谷区" },
          { name: "ZENクリニック", key: "zen", url: "https://zen.jp/", area: "東京都中央区" },
          ...fill("navi", 4),
        ],
      },
      [biyou]: {
        title: "マンジャロ 処方 クリニック 全国",
        items: [
          { name: "やまもと内科クリニック やまもと内科クリニック 広島市", key: "やまもと内科やまもと内科広島市", url: "https://biyou-navi.jp/c/1/", area: "広島県広島市中区" },
          { name: "ありずみ消化器内科", key: "ありずみ消化器内科", url: "https://biyou-navi.jp/c/2/", area: "大阪府大阪市北区" },
          { name: "さくら内科クリニック", key: "さくら内科", url: "https://biyou-navi.jp/c/3/", area: "北海道旭川市1条通" }, // another city: another clinic
          { name: "東京シルククリニック", key: "東京シルク", url: "https://biyou-navi.jp/c/4/", area: "東京都千代田区" },
          { name: "新宿駅前クリニック", key: "新宿駅前", url: "https://biyou-navi.jp/c/5/", area: "東京都新宿区" },
          { name: "우드랜드 클리닉", key: "우드랜드", url: "https://biyou-navi.jp/c/6/", area: "宮城県仙台市青葉区" },
          { name: "Mast Beauty", key: "mastbeauty", url: "https://biyou-navi.jp/c/7/", area: "東京都港区" },
          { name: "MBDクリニック", key: "mbd", url: "https://biyou-navi.jp/c/8/", area: "東京都渋谷区" },
          { name: "ZEN CLINIC", key: "zen", url: "https://biyou-navi.jp/c/9/", area: "東京都中央区" },
          // a brand and its towns, no kind word before them: two
          { name: "ひまわり 本町", key: "ひまわり本町", url: "https://biyou-navi.jp/c/10/", area: "大阪府大阪市中央区" },
          { name: "ひまわり 栄町", key: "ひまわり栄町", url: "https://biyou-navi.jp/c/11/", area: "大阪府大阪市北区" },
          { name: "UBCLINIC池袋東口院", key: "ubclinic池袋東口院", url: "https://biyou-navi.jp/c/12/", area: "東京都豊島区" },
          ...fill("biyou", 3),
        ],
      },
      [excel]: {
        title: "일본 마운자로 클리닉 가격 비교",
        items: [
          { name: "UB클리닉 이케부쿠로 히가시구치점", key: "ub이케부쿠로히가시구치점", url: "https://excel.example.kr/c/ub", text: "도쿄 · 이케부쿠로 · 9,000엔" },
          // a two-letter core is too common a name to match by: two
          { name: "하나 클리닉 (우에노)", key: "하나우에노", url: "https://excel.example.kr/c/hana-ueno", text: "도쿄 · 9,000엔" },
          { name: "하나 의원", key: "하나", url: "https://excel.example.kr/c/hana", text: "도쿄 · 8,000엔" },
          // branches written with the prefecture's name and 원; a main branch and another: two
          { name: "W 클리닉 오사카 우메다원", key: "w오사카우메다원", url: "https://excel.example.kr/c/w-umeda", text: "오사카 · 우메다 · 9,000엔" },
          { name: "다이비카이 클리닉 텐노지원", key: "다이비카이텐노지원", url: "https://excel.example.kr/c/daibi-tennoji", text: "오사카 · 9,000엔" },
          { name: "다이비카이 클리닉 우메다원", key: "다이비카이우메다원", url: "https://excel.example.kr/c/daibi-umeda", text: "오사카 · 9,000엔" },
          { name: "루라 미용 클리닉 오사카본원", key: "루라미용오사카본원", url: "https://excel.example.kr/c/rura", text: "오사카 · 9,000엔" },
          { name: "루라 미용 클리닉 오사카 신사이바시원", key: "루라미용오사카신사이바시원", url: "https://excel.example.kr/c/rura-shinsaibashi", text: "오사카 · 9,000엔" },
          // the prefecture's name with no finer place: part of the name
          { name: "오사카 스마일 클리닉", key: "오사카스마일", url: "https://excel.example.kr/c/osaka-smile", text: "오사카 · 9,000엔" },
          { name: "스마일 클리닉", key: "스마일", url: "https://excel.example.kr/c/smile", text: "오사카 · 8,000엔" },
          ...fill("excel", 3),
        ],
      },
      [ko]: {
        title: "일본 마운자로 병원 목록",
        items: [
          { name: "야마모토 내과 클리닉 (やまもと内科クリニック)", key: "야마모토내과やまもと内科", url: "https://list.jarodb.kr/c/yamamoto", text: "히로시마 · 9,000엔" },
          // the same original in Osaka: another prefecture's
          { name: "야마모토 내과 클리닉 우메다 (やまもと内科クリニック)", key: "야마모토내과우메다やまもと内科", url: "https://list.jarodb.kr/c/yamamoto-umeda", text: "오사카 · 9,000엔" },
          { name: "도쿄 실크 클리닉 신주쿠원 (東京シルククリニック)", key: "도쿄실크신주쿠원東京シルク", url: "https://list.jarodb.kr/c/silk-shinjuku", text: "도쿄 · 9,980엔" },
          // the same bracket on another branch: biyou's one entry is one of the two, not both
          { name: "도쿄 실크 클리닉 간다원 (東京シルククリニック)", key: "도쿄실크간다원東京シルク", url: "https://list.jarodb.kr/c/silk-kanda", text: "도쿄 · 9,980엔" },
          // two bracketed names alike, nothing plain: two
          { name: "폰타나 클리닉 텐진원 (フォンタナクリニック)", key: "폰타나텐진원フォンタナ", url: "https://list.jarodb.kr/c/fontana-tenjin", text: "후쿠오카 · 9,000엔" },
          { name: "폰타나 클리닉 하카타원 (フォンタナクリニック)", key: "폰타나하카타원フォンタナ", url: "https://list.jarodb.kr/c/fontana-hakata", text: "후쿠오카 · 9,000엔" },
          { name: "DMM 온라인 클리닉 (DMMオンラインクリニック)", key: "dmm온라인dmmオンライン", url: "https://list.jarodb.kr/c/dmm" },
          // kanji alone in brackets, no kind word: a place, never 新宿駅前クリニック
          { name: "서울 클리닉 (新宿駅前)", key: "서울新宿駅前", url: "https://list.jarodb.kr/c/seoul", text: "도쿄 · 8,000엔" },
          // a branch in brackets: a region (two cities in one script: two), or a word of the name's own script
          ...["다치카와", "가와고에", "마치다"].map((b, i) => ({ name: `이스트 에키마에 클리닉 (${b})`, key: `이스트에키마에${b}`, url: `https://list.jarodb.kr/c/east-${i}`, text: "간토 · 9,000엔" })),
          // online care and the same name: one place; online care and a branch with a city: two
          { name: "오리가미 클리닉", key: "오리가미", url: "https://list.jarodb.kr/c/origami", text: "도쿄 · 9,000엔" },
          { name: "오리가미 클리닉(온라인)", key: "오리가미온라인", url: "https://list.jarodb.kr/c/origami-online" },
          { name: "MY 뷰티 클리닉 (긴자)", key: "my뷰티긴자", url: "https://list.jarodb.kr/c/my-ginza", text: "도쿄 · 9,000엔" },
          { name: "MY 뷰티 클리닉 (온라인)", key: "my뷰티온라인", url: "https://list.jarodb.kr/c/my-online" },
          // a region in Korean and a city in Japanese: one prefecture, one place
          { name: "우드랜드 클리닉(센다이)", key: "우드랜드센다이", url: "https://list.jarodb.kr/c/woodland", text: "센다이 · 9,000엔" },
          // a bilingual entry (the Japanese name in its text): excel's entry and biyou's become one place
          { name: "UB클리닉 이케부쿠로 히가시구치점", key: "ub이케부쿠로히가시구치점2", url: "https://list.jarodb.kr/c/ub", text: "UBCLINIC池袋東口院 · 2.5mg 4주 ¥9,000" },
          // excel's branches: without the prefecture's name, with 덴 for 텐, without 원
          { name: "W 클리닉 우메다원 (Wクリニック 梅田院)", key: "w우메다원w梅田院", url: "https://list.jarodb.kr/c/w-umeda", text: "오사카 · 9,000엔" },
          { name: "다이비카이 클리닉 덴노지원", key: "다이비카이덴노지원", url: "https://list.jarodb.kr/c/daibi-tennoji", text: "오사카 · 9,000엔" },
          { name: "다이비카이 클리닉 우메다", key: "다이비카이우메다", url: "https://list.jarodb.kr/c/daibi-umeda", text: "오사카 · 9,000엔" },
        ],
      },
      [jp2]: {
        title: "マンジャロ オンライン診療 クリニック一覧",
        items: [
          { name: "DMMオンラインクリニック", key: "dmmオンライン", url: "https://clinic.dmm.com/" },
          { name: "Wクリニック 大阪梅田院", key: "w大阪梅田院", url: "https://w-clinic.jp/umeda/", area: "大阪府大阪市北区" },
          // entries named by their links: no places
          { name: "公式サイト", key: "公式サイト", url: "https://kenbi-clinic.com/", area: "大阪府大阪市北区", text: "診察料 · 無料" },
          { name: "https://dioclinic.jp/clinic/osakaeki/", key: "httpsdiojposakaeki", url: "https://dioclinic.jp/clinic/osakaeki/", area: "大阪市北区" },
          ...fill("jp2", 7),
        ],
      },
    };
    const r = siteReader(pages);
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    for (const u of [navi, biyou, excel, ko, jp2]) await modelRead(t, r.def, u);
    // navi 12; biyou 15, five seen (やまもと 広島市, ありずみ 大阪市, Mast Beauty, MBD, ZEN); excel 13; ko 20, eight seen
    // (やまもと, 東京シルク, 오리가미, 우드랜드, UB, W, 다이비카이 ×2) and excel's UB one with biyou's; jp2 11, DMM and W seen,
    // two named by links
    expect(t.listPlaces()).toBe(12 + 10 + 13 + (12 - 1) + 7);
    // the model's row with the Japanese name in brackets takes navi's entry written with its city
    const { html, line } = await drawWith(t, undefined, [["군마", "군마노모리 정형외과 클리닉 (整形外科 ぐんまの森クリニック)", "다카사키", "3,000엔", "", ko, "정리 사이트"]]);
    const names = namesOn(html);
    expect(names).toHaveLength(1 + 52);
    expect(line).toBe("카드에 53곳 전부 정리했어요.");
    for (const n of [
      "やまもと内科クリニック広島市",
      "やまもと内科クリニック福山市",
      "야마모토 내과 클리닉 우메다 (やまもと内科クリニック)",
      "さくら内科クリニック(札幌市)",
      "さくら内科クリニック",
      "Mast Beauty(港区)",
      "MBDクリニック",
      "ZENクリニック",
      "ひまわり 本町",
      "ひまわり 栄町",
      "東京シルククリニック",
      "도쿄 실크 클리닉 간다원 (東京シルククリニック)",
      "폰타나 클리닉 텐진원 (フォンタナクリニック)",
      "폰타나 클리닉 하카타원 (フォンタナクリニック)",
      "DMM 온라인 클리닉 (DMMオンラインクリニック)",
      "新宿駅前クリニック",
      "서울 클리닉 (新宿駅前)",
      "이스트 에키마에 클리닉 (다치카와)",
      "이스트 에키마에 클리닉 (가와고에)",
      "이스트 에키마에 클리닉 (마치다)",
      "오리가미 클리닉",
      "MY 뷰티 클리닉 (긴자)",
      "MY 뷰티 클리닉 (온라인)",
      "우드랜드 클리닉",
      "UBCLINIC池袋東口院",
      "하나 클리닉 (우에노)",
      "하나 의원",
      "W 클리닉 오사카 우메다원",
      "다이비카이 클리닉 텐노지원",
      "다이비카이 클리닉 우메다원",
      "루라 미용 클리닉 오사카본원",
      "루라 미용 클리닉 오사카 신사이바시원",
      "오사카 스마일 클리닉",
      "스마일 클리닉",
    ])
      expect(names).toContain(n);
    for (const n of [
      "やまもと内科クリニック やまもと内科クリニック 広島市",
      "ありずみ消化器内科",
      "Mast Beauty",
      "ZEN CLINIC",
      "야마모토 내과 클리닉 (やまもと内科クリニック)",
      "도쿄 실크 클리닉 신주쿠원 (東京シルククリニック)",
      "整形外科 ぐんまの森クリニック高崎市",
      "오리가미 클리닉(온라인)",
      "우드랜드 클리닉(센다이)",
      "UB클리닉 이케부쿠로 히가시구치점",
      "DMMオンラインクリニック",
      "W 클리닉 우메다원 (Wクリニック 梅田院)",
      "Wクリニック 大阪梅田院",
      "다이비카이 클리닉 덴노지원",
      "다이비카이 클리닉 우메다",
      "公式サイト",
      "https://dioclinic.jp/clinic/osakaeki/",
    ])
      expect(names).not.toContain(n);
    // a model's row under another prefecture's group takes no entry of that name; two bracketed names never one
    const other = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    const r2 = siteReader(pages);
    for (const u of [navi, ko]) await modelRead(other, r2.def, u);
    const far = await drawWith(other, undefined, [
      ["오사카", "야마모토 내과 클리닉 신사이바시 (やまもと内科クリニック)", "", "", "", "https://yamamoto-osaka.jp/", "공식 페이지"],
      ["후쿠오카", "폰타나 클리닉 나카스원 (フォンタナクリニック)", "", "", "", "https://fontana-nakasu.jp/", "공식 페이지"],
    ]);
    for (const n of ["やまもと内科クリニック広島市", "폰타나 클리닉 텐진원 (フォンタナクリニック)", "폰타나 클리닉 하카타원 (フォンタナクリニック)"]) expect(namesOn(far.html)).toContain(n);
  });

  test("mirai's pages as web_read gives them since 8d70019 (a table's names, the city in its own field, online clinics atop every page): one name in three cities is three places, a front page's name with its city glued is its region page's, an online clinic with a LINE link only is one place, a 一般社団法人 clinic in full-width letters is a place; a model's row takes its own region's branch, or the one place of its name", async () => {
    const online = [
      { name: "ミライメディカルクリニック マンジャロ", key: "ミライマンジャロ", area: "オンライン", contacts: ["LINE 友だち追加 https://liff.line.me/2006391946"], text: "マンジャロ 2,750円 /1本" },
      { name: "デジタルクリニック マンジャロ", key: "デジタルマンジャロ", area: "オンライン", url: "https://digital-clinic.example.jp/", text: "マンジャロ 2,980円 /1本" },
    ];
    const town = (area: string, tag: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `${tag}${"あいうえおかきくけこ"[i]}クリニック`, key: `${tag}${no(i)}`, area, url: `https://${encodeURIComponent(tag)}${i}.example.jp/`, text: "3,000円 /1本" }));
    const page = (items: Record<string, unknown>[]) => ({ title: `マンジャロおすすめクリニック一覧${items.length + online.length}院`, items: [...online, ...items] });
    const asahi = (area: string) => ({ name: "あさひ美容外科", key: "あさひ美容外科", area, url: "https://asahi-biyou.example.jp/", text: "8,800円 /1本" });
    const pages = {
      [MIRAI]: {
        title: "全国のマンジャロが安いおすすめクリニック一覧665院",
        items: [
          { name: "愛和クリニック調布市", key: "愛和クリニック調布市", url: pref(13), area: "調布市", links: [{ url: "https://aiwa.example.jp/" }], text: "3,000円 /1本" },
          ...town("港区", "港", 7).map((x) => ({ ...x, name: `${x.name}港区`, key: `${x.key}港区`, url: pref(13) })),
        ],
      },
      [pref(13)]: page([
        { name: "愛和クリニック", key: "愛和", area: "調布市", url: "https://aiwa.example.jp/", text: "3,000円 /1本" },
        { name: "一般社団法人帰蝶会 Ｔｏｋｙｏ Ｂｅａｕｔｙ Ｍａｓｔｅｒ ｃｌｉｎｉｃ", key: "一般社団法人帰蝶会tokyobeautymaster", area: "港区", url: "https://tokyobeautymaster.example.jp/", text: "17,000円" },
        ...town("港区", "港", 7),
      ]),
      [pref(27)]: page([
        asahi("堺市"),
        { name: "一般社団法人 森美会 Ｍ Ｂｅａｕｔｙ Ｃｌｉｎｉｃ", key: "一般社団法人森美会mbeauty", area: "大阪市", url: "https://mbeauty.example.jp/", text: "8,800円 /1本" },
        ...town("大阪市", "梅田", 6).map((x, i) => (i === 0 ? { ...x, tel: "06-6311-2045" } : x)),
      ]),
      // a Korean list whose clinics give a LINE id only, beside a few links that are no places
      "https://line-list.example.kr/": {
        title: "후쿠오카 마운자로 클리닉 LINE 상담 목록",
        items: [
          ...["블로그 소개", "이웃 추가", "구독 안내"].map((name, i) => ({ name, key: `x${i}`, url: `https://line-list.example.kr/p${i}` })),
          ...Array.from({ length: 8 }, (_, i) => ({ name: `하카타 라인 클리닉 ${no(i)}`, key: `하카타라인${no(i)}`, contacts: [`LINE @hakata${i}`], text: "후쿠오카 · 9,000엔" })),
        ],
      },
      [pref(29)]: page([asahi("奈良市"), ...town("奈良市", "奈良", 6).map((x, i) => (i === 1 ? { ...x, tel: "0120-917-302" } : x))]),
      [pref(30)]: page([asahi("和歌山市"), ...town("和歌山市", "和歌山", 6)]),
      // a company named as such, and links named by what they do, stay out
      "https://corp.example.jp/list/": {
        title: "マンジャロ 取扱クリニック一覧",
        items: [
          { name: "株式会社メディサポ", key: "株式会社メディサポ", url: "https://medisapo.example.jp/" },
          { name: "予約ページで空き枠を確認する", key: "予約ページで空き枠を確認する", url: "https://radias.example.jp/reserve/" },
          { name: "온라인 예약하기", key: "온라인예약하기", url: "https://radias.example.jp/ko/reserve/" },
          { name: "クリニックはこちら", key: "はこちら", url: "https://radias.example.jp/clinic/" },
          // one phone: in one city one place (梅田あ, written in English), in two cities two (a call centre's number)
          { name: "UMEDA A CLINIC", key: "umedaa", area: "大阪市", tel: "0663112045", url: "https://umeda-a.example.com/" },
          { name: "内科 (福岡市)", key: "内科福岡市", area: "福岡市", tel: "0927110231" },
          // a kind word alone is no name to match by ('内科' in both, two phones)
          { name: "内科 (Naika)", key: "内科naika", area: "福岡市", tel: "0927110987" },
          ...town("福岡市", "天神", 8).map((x, i) => (i === 0 ? { ...x, tel: "0120917302" } : x)),
        ],
      },
    };
    const r = siteReader(pages);
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    for (const u of Object.keys(pages)) await modelRead(t, r.def, u);
    // online 2; Tokyo 9 (愛和 once, the front's 港 entries its page's); Osaka 8 (UMEDA A CLINIC is 梅田あ by its
    // phone); Nara 7; Wakayama 7; Fukuoka 10 (天神 8, two 内科); the LINE list 8 and its 3 links
    const all = 2 + 9 + 8 + 7 + 7 + 10 + 8 + 3;
    expect(t.listPlaces()).toBe(all);
    // the model's あさひ in 오사카 is 堺市's; its 奈良 clinic under 도쿄 (no such name there) is still Nara's
    const { html, line } = await drawWith(t, undefined, [
      ["오사카", "あさひ美容外科", "사카이", "8,800엔", "", "", "공식 페이지"],
      ["도쿄", "奈良えクリニック", "", "3,000엔", "", "", "공식 페이지"],
      // a row the list's 梅田あ is by its phone only (the list writes it with hyphens)
      ["오사카", "우메다 A", "", "3,000엔", "+81 6-6311-2045", "", "공식 페이지"],
    ]);
    const names = namesOn(html);
    expect(names.filter((n) => n === "あさひ美容外科")).toHaveLength(3);
    expect(names.filter((n) => n === "奈良えクリニック")).toHaveLength(1);
    expect(names.filter((n) => n.startsWith("ミライメディカルクリニック"))).toHaveLength(1);
    expect(names.filter((n) => n.startsWith("愛和クリニック"))).toHaveLength(1);
    for (const n of ["一般社団法人帰蝶会 Tokyo Beauty Master clinic", "一般社団法人 森美会 M Beauty Clinic", "デジタルクリニック マンジャロ"]) expect(names).toContain(n);
    for (const n of ["株式会社メディサポ", "予約ページで空き枠を確認する", "온라인 예약하기", "クリニックはこちら"]) expect(names).not.toContain(n);
    for (const n of ["奈良いクリニック", "天神あクリニック", "内科 (福岡市)", "内科 (Naika)", "하카타 라인 클리닉 007"]) expect(names).toContain(n);
    for (const n of ["UMEDA A CLINIC", "梅田あクリニック"]) expect(names).not.toContain(n);
    expect(line).toBe(`카드에 ${all}곳 전부 정리했어요.`);
  });

  test("the card's reads end at the read-on deadline: a page under way then is cut by its signal, so the card is drawn on time", async () => {
    const pages = miraiPages();
    let cut = 0;
    const slow = {
      ...siteReader(pages).def,
      run: async (a: { url: string; itemsFrom?: number }, ctx: ToolContext) => {
        if (a.url === MIRAI) return siteReader(pages).def.run(a, ctx);
        // a region page that would take 5 s
        const aborted = await new Promise<boolean>((done) => {
          const timer = setTimeout(() => done(false), 5_000);
          ctx.signal.addEventListener("abort", () => (clearTimeout(timer), done(true)), { once: true });
        });
        if (aborted) cut++;
        return aborted ? { ok: false, summary: "", data: { error: "timeout", url: a.url } } : siteReader(pages).def.run(a, ctx);
      },
    } as unknown as ToolDef;
    const t = new ExploreTracker({ cardReadGapMs: 0, cardReadMs: 300 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, slow, MIRAI);
    const t0 = Date.now();
    const { line } = await drawWith(t, slow, []);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(cut).toBe(1);
    expect(t.drawn()!.rows).toBe(7); // the front's
    expect(line).toContain("md.mirai-medical.clinic(665곳 중 7곳)");
  });

  test("an entry named like an article is no place even with its link among the clinics' own pages (each wording alone); a short clinic name with such a word is one", async () => {
    const url = "https://navi.example.jp/mounjaro/";
    const page = (i: number) => `https://navi.example.jp/mounjaro/clinic/${i}/`;
    const clinics = Array.from({ length: 10 }, (_, i) => ({ name: `新宿ナビクリニック${no(i)}`, key: `新宿ナビ${no(i)}`, url: page(i), area: "東京都新宿区" }));
    // one wording each, linking a page in the clinics' own folder (no other rule takes them)
    const articles = [
      "東京のマンジャロ処方クリニック10選と料金の目安",
      "渋谷で今行くべきおすすめマンジャロクリニック一挙紹介",
      "大阪マンジャロクリニック料金ランキング最新版2026",
      "新宿エリアのマンジャロ処方クリニック情報まとめ2026",
      "池袋エリアのマンジャロ処方クリニック料金を比較した結果",
      "【保存版】池袋で人気のマンジャロ対応クリニック紹介",
      "마운자로 처방 병원 가격 총정리 2026년 11월판",
      "도쿄 마운자로 클리닉 추천 리스트 신주쿠편 2026",
      "도쿄 마운자로 클리닉 가격 비교 신주쿠편 2026년",
      "오사카 마운자로 클리닉 가격 순위 우메다편 2026년",
      "Best 10 Mounjaro Clinics in Tokyo for Travelers",
      "Top 5 Mounjaro Clinics in Osaka for Tourists 2026",
    ].map((name, i) => ({ name, key: `article${i}`, url: page(100 + i), area: "東京都" }));
    const short = { name: "比較クリニック新宿", key: "比較新宿", url: page(200), area: "東京都新宿区" };
    const r = siteReader({ [url]: { title: "東京のマンジャロ処方クリニック一覧", items: [...clinics, ...articles, short] } });
    const t = new ExploreTracker({ cardReadGapMs: 0 }, Date.now(), "text", { text: `${ASK_ALL} 카드로`, card: ART });
    await modelRead(t, r.def, url);
    await modelRead(t, r.def, url); // web_read's 20 a page: the rest from itemsFrom
    t.call(r.def, "web_read", { url, itemsFrom: 20 });
    t.result(r.def, await r.def.run({ url, itemsFrom: 20 }, fakeCtx()));
    expect(t.listPlaces()).toBe(11);
    const names = namesOn((await drawWith(t, r.def, [])).html);
    expect(names.filter((n) => articles.some((a) => a.name === n))).toEqual([]);
    expect(names).toContain("比較クリニック新宿");
  });
});
