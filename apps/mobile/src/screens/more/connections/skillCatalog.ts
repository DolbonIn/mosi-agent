/**
 * Words for the k-skill services (KSKILL-LOGIN-BRIEF A and C) on top of what the server lists. The server is the
 * source of the services themselves: GET /api/connections lists each as a ProviderInfo (category "korea", auth
 * "api_key") with its fields (kskill-tools' connectionServices(); ids are vault service ids, not k-skill folder names), and connects them through POST /api/connections/:id (docs/architecture/KSKILL-CONNECTIONS.md). This file
 * only adds the person's view: what connecting unlocks (the row's subtitle), one plain line of what the agent does
 * with it (saying it only reads, where true), where the key is issued, and what to ask once it's connected.
 * No logos: none of these has a mark in assets/brands, so the rows are words only (DESIGN.md).
 *
 * `auth: "browser"` services sign in on their own page through the login relay: listed only when the server marks
 * them available, and "곧 연결돼요" until the relay is wired into the sheet (kskill-tools phase 2).
 *
 * A row shows only when the server lists its service: today that's 토스증권, 네이버 검색광고, 팝빌, 쿠팡 파트너스 and
 * RISS. The C keys (건축물대장, 특허, LCK, 국채) have no tool yet, so "키로 연결" stays out until the server lists one.
 *
 * Not offered (lead, 2026-11-12): 번개장터 and 사람인 (their terms forbid it), 잡코리아 and CODEF (parked), 숲나들e (parked:
 * its login sits behind anti-crawling checks we won't bypass) — hidden even if a server lists them (SKILL_HIDDEN).
 */
export interface SkillIssue {
  /** the question the line answers (default "어디서 발급하나요?") */
  ask?: string;
  /** the path on the official site, e.g. "네이버 검색광고 › 도구 › API 사용 관리" */
  where: string;
  /** the official console; absent when there isn't one */
  url?: string;
  /** one short caveat after the path */
  note?: string;
}

export interface SkillCopy {
  id: string;
  name: string;
  /** A = log in with your own account; C = an optional developer key ("키로 연결") */
  section: "account" | "key";
  auth: "fields" | "browser";
  /** the row's subtitle before connecting: what connecting unlocks, a few words */
  unlocks: string;
  /** one plain line: what the agent does with it; says "only reads" where true */
  does: string;
  /** a caveat to read before filling the form (the sheet's first line), e.g. who can get the key at all */
  notice?: string;
  issue?: SkillIssue;
  /** what to ask once connected (chips that put the words into the composer) */
  examples: string[];
}

export const SKILL_COPY: SkillCopy[] = [
  {
    id: "toss-investment",
    name: "토스증권",
    section: "account",
    auth: "fields",
    unlocks: "계좌 · 보유 종목 조회",
    does: "계좌와 보유 종목, 시세를 조회만 해요. 주문은 넣지 않아요.",
    issue: { where: "토스증권 PC 웹 › 설정 › Open API", url: "https://www.tossinvest.com" },
    examples: ["내 토스증권 보유 종목 보여 줘", "삼성전자 지금 얼마야?"],
  },
  {
    id: "heyyumi",
    name: "헤이유미",
    section: "account",
    auth: "browser",
    unlocks: "식당 · 카페 검색, 예약 요청",
    does: "식당과 카페를 찾고, 내가 허락하면 예약을 요청해요.",
    examples: ["오늘 저녁 7시 2명 예약할 만한 곳 찾아 줘"],
  },
  {
    id: "naver-searchad",
    name: "네이버 검색광고",
    section: "account",
    auth: "fields",
    unlocks: "광고 성과 조회",
    does: "캠페인과 키워드의 광고 성과를 조회만 해요. 입찰가·예산·캠페인은 바꾸지 않아요.",
    issue: { where: "네이버 검색광고 › 도구 › API 사용 관리", url: "https://searchad.naver.com" },
    examples: ["지난주 검색광고 성과 정리해 줘"],
  },
  {
    id: "popbill",
    name: "팝빌",
    section: "account",
    auth: "fields",
    unlocks: "전자세금계산서 조회 · 발행",
    does: "전자세금계산서를 조회하고, 내가 승인하면 발행하거나 다시 보내요.",
    issue: { where: "팝빌 개발자센터 › 연동 신청", url: "https://developers.popbill.com" },
    examples: ["이번 달 발행한 세금계산서 보여 줘"],
  },
  {
    id: "coupang-partners",
    name: "쿠팡 파트너스",
    section: "account",
    auth: "fields",
    unlocks: "상품 · 로켓배송 가격 검색",
    does: "상품과 로켓배송 가격을 검색만 해요. 주문은 하지 않아요.",
    issue: { where: "쿠팡 파트너스 › 추가 기능 › 오픈 API", url: "https://partners.coupang.com" },
    examples: ["쿠팡에서 로켓배송 되는 무선 청소기 찾아 줘"],
  },
  {
    id: "riss",
    name: "RISS",
    section: "account",
    auth: "fields",
    unlocks: "학위논문 · 학술지 검색",
    does: "학위논문과 학술지 논문을 검색만 해요. 원문 다운로드나 신청은 하지 않아요.",
    notice: "RISS 검색 API 키는 대학과 비영리 기관에만 발급돼요. 개인은 대부분 받을 수 없어요.",
    issue: { where: "RISS API 센터 › 검색 API 이용 신청", url: "https://www.riss.kr/apicenter/apiMain.do" },
    examples: ["RISS에서 생성형 AI 교육 논문 찾아 줘"],
  },
  // ── C: an optional developer key ──
  {
    id: "building-register-search",
    name: "건축물대장",
    section: "key",
    auth: "fields",
    unlocks: "공공데이터포털 키 · 없어도 기본 조회는 돼요",
    does: "건물의 층수 · 용도 · 면적을 건축물대장에서 조회만 해요.",
    issue: { where: "공공데이터포털 › 건축HUB 건축물대장정보 › 활용 신청", url: "https://www.data.go.kr/data/15134735/openapi.do" },
    examples: ["이 주소 건물 건축물대장 보여 줘"],
  },
  {
    id: "korean-patent-search",
    name: "특허 검색",
    section: "key",
    auth: "fields",
    unlocks: "KIPRIS Plus 키 · 있어야 검색돼요",
    does: "특허와 실용신안을 검색만 해요.",
    issue: { where: "KIPRIS Plus › 데이터 › 서비스 신청", url: "https://plus.kipris.or.kr" },
    examples: ["배터리 관련 한국 특허 찾아 줘"],
  },
  {
    id: "lck-analytics",
    name: "LCK 경기 기록",
    section: "key",
    auth: "fields",
    unlocks: "LoL Esports 키 · 없어도 기본 조회는 돼요",
    does: "LCK 경기 일정과 순위, 경기 기록을 조회만 해요.",
    issue: { ask: "언제 필요한가요?", where: "공개 키가 막혔을 때만 넣어요", note: "평소에는 비워 둬도 돼요." },
    examples: ["오늘 LCK 경기 결과 알려 줘"],
  },
  {
    id: "government-bond-analysis",
    name: "국채 금리 분석",
    section: "key",
    auth: "fields",
    unlocks: "한국은행 ECOS 키 · 없어도 기본 조회는 돼요",
    does: "국고채 금리를 한국은행 ECOS에서 조회해 정리만 해요. 매매 권유는 하지 않아요.",
    issue: { where: "한국은행 ECOS › Open API › 인증키 신청", url: "https://ecos.bok.or.kr/api/" },
    examples: ["이번 주 국고채 3년물 금리 흐름 정리해 줘"],
  },
];

/** k-skill services the app never lists, whatever the server sends (see the header) */
export const SKILL_HIDDEN = new Set(["bunjang-search", "saramin-talent-search", "jobkorea-talent-search", "korean-jangbu-for", "foresttrip-vacancy"]);

export const SKILL_COPY_BY_ID = new Map(SKILL_COPY.map((s) => [s.id, s]));
export const skillCopy = (id: string) => SKILL_COPY_BY_ID.get(id);

/**
 * The chat card's line (connection_request): what the agent does with the login — the sheet's scope line — where the app
 * has words for the service; any other service keeps the server's reason (design-director, skill-ui-11 a).
 */
/** a line cut after each sentence ("…해요. …않아요." → two), so the UI can break it only between sentences */
export { sentencesOf } from "../../../ui/Text";

export const requestLine = (card: { service: string; reason?: string }) => skillCopy(card.service)?.does ?? card.reason?.trim() ?? "";

/** the sealing sentence, said once under the last secret field (the messenger sheet's words) */
export const lockSentence = (agentName: string) => `입력한 정보는 이 기기에서 암호화한 뒤에만 보내요. ${agentName}도 서버 운영자도 원문을 볼 수 없어요.`;
