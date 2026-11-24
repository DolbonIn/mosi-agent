/**
 * 둘러보기: the 7 real categories, task templates that map ONLY to capabilities that exist
 * (k-skill tools, messenger tools, system tools, sys_phone_call), personalised suggestions
 * ("<agentName>의 제안"), and delegation into a `task` thread.
 *
 * Template text may contain {displayName} / {agentName} placeholders (only before particles that
 * do not alternate, e.g. "에게"). `call-demo` is special-cased by the app (opens the voice call).
 *
 * A template's `prompt` is what the person sends on "부탁하기": one short line in their own words. It is the bubble,
 * the thread preview and the stored text, so it never names a tool or a rule (DD 1407). How to do it (tool ids, rule
 * syntax, what to ask first) is the template's `hint`: it reaches the model only, appended to the model copy of the
 * first message of a new task thread whose text is that template's line (see templateHint).
 */
import type { DelegateResponse, ExploreResponse, IconName, TaskTemplate, TemplateCategory } from "@pickle/protocol";
import type { TemplateRow, UserRow } from "./db/index.ts";
import { publishThread, threadViewById, type Core } from "./core.ts";
import { json, notFound, type Ctx } from "./http.ts";
import { kstParts } from "./kst.ts";
import { newId, safeJson } from "./util.ts";

export const CATEGORIES: TemplateCategory[] = [
  { id: "recommend", title: "추천", icon: "star", emoji3d: "star" },
  { id: "benefit", title: "혜택", icon: "coins", emoji3d: "coins" },
  { id: "shopping", title: "쇼핑", icon: "bag", emoji3d: "bag" },
  { id: "travel", title: "여행", icon: "plane", emoji3d: "plane" },
  { id: "people", title: "사람", icon: "people", emoji3d: "people" },
  { id: "culture", title: "문화", icon: "film", emoji3d: "film" },
  { id: "home", title: "집·생활", icon: "house", emoji3d: "house" },
];

interface Seed {
  id: string;
  category: string;
  title: string;
  description: string;
  icon: IconName;
  hue: number;
  /** the person's own short line: the bubble on 부탁하기 (no tool ids, no rule syntax) */
  prompt: string;
  /** model-only: how to do it, added to the model copy of that first message */
  hint?: string;
  /** the agent asks for missing details before it starts (PreDelegateSheet's note) */
  asksFirst?: boolean;
  skills: string[];
  hidden?: boolean;
}

export const CALL_DEMO_GREETING = "누구에게 어떤 용건으로 전화할까요? 상대 번호와 하고 싶은 말을 알려 주시면, 걸기 전에 한 번 더 확인받을게요.";

export const TEMPLATE_SEEDS: Seed[] = [
  {
    id: "call-demo",
    category: "recommend",
    title: "제 전화, 먼저 한번 받아 보실래요?",
    description: "지금 바로 전화를 걸어요. 다른 사람에게 걸 때 어떻게 들리는지 직접 들어 보세요.",
    icon: "phone",
    hue: 205,
    prompt: "",
    skills: [],
  },
  {
    id: "gov-benefits",
    category: "benefit",
    title: "내가 받을 수 있는 정부 지원사업을 찾아 드릴게요.",
    description: "K-Startup·기업마당 등 지금 신청할 수 있는 지원사업과 청년·주거 공고(LH)를 내 조건에 맞춰 마감 순으로 정리해요.",
    icon: "coins",
    hue: 45,
    prompt: "지금 신청할 수 있는 정부 지원사업과 청년·주거 공고를 내 조건에 맞춰 찾아 줘.",
    hint:
      "내 조건(지역·나이·상황)을 먼저 물어본 뒤 마감 순으로 정리해 줘. 사는 지역(시·군·구), 나이, 재직·구직·창업 여부 중 아직 모르는 것만 한 번에 짧게 물어봐. 정보가 모이면 k_gov_support로 지원사업 공고를, 주거 지원이 해당되면 k_housing_notices로 지금 모집 중인 청약·임대 공고를 확인해 줘. 항목마다 지원 내용·대상·마감일을 한 줄씩 적고, 조건이 애매한 건 확인이 필요하다고 표시해 줘.",
    asksFirst: true,
    skills: ["k_gov_support", "k_housing_notices"],
  },
  {
    id: "morning-briefing",
    category: "recommend",
    title: "매일 아침 7시 모닝 브리핑 보내 드릴게요",
    description: "날씨·미세먼지·주요 뉴스·오늘 일정을 매일 아침 7시에 한 번에 정리해 먼저 보내 드려요.",
    icon: "sun",
    hue: 38,
    prompt: "매일 아침 7시에 모닝 브리핑을 보내 줘.",
    hint:
      "내가 사는 동네를 모르면 먼저 물어봐. 그다음 sys_schedule_create로 제목 '모닝 브리핑', 규칙 daily@07:00, 내용 '내 동네 날씨와 미세먼지(k_weather, k_fine_dust), 오늘 주요 뉴스 3개(k_news), 오늘 일정을 정리해서 sys_show_briefing 카드로 보여 줘'인 예약을 만들어 줘. 만든 뒤에는 오늘 치 브리핑도 지금 바로 한 번 보여 줘.",
    asksFirst: true,
    skills: ["sys_schedule_create", "k_weather", "k_fine_dust", "k_news", "sys_show_briefing"],
  },
  {
    id: "news-briefing",
    category: "recommend",
    title: "오늘 주요 뉴스 브리핑해 드릴게요",
    description: "오늘 꼭 알아야 할 뉴스를 분야별로 골라 세 줄씩 요약해 드려요.",
    icon: "doc",
    hue: 215,
    prompt: "오늘 주요 뉴스를 브리핑해 줘.",
    hint:
      "k_news로 정치·경제·사회·IT 분야의 오늘 주요 뉴스를 찾아, 분야별로 가장 중요한 1~2개만 골라 세 줄 이내로 요약해 줘. 마지막에 더 자세히 알고 싶은 뉴스가 있는지 물어봐.",
    skills: ["k_news"],
  },
  {
    id: "stock-watch",
    category: "home",
    title: "관심 종목 기본 정보와 소식 정리해 드릴게요",
    description: "관심 있는 종목의 기본 정보와 최근 뉴스를 한눈에 정리해 드려요.",
    icon: "chart",
    hue: 160,
    prompt: "내 관심 종목을 정리해 줘.",
    hint:
      "관심 종목을 모르면 종목 이름을 먼저 물어봐. k_stock으로 종목마다 기본 정보(시장·업종 등)를 조회하고, k_news로 최근 관련 뉴스를 2~3개씩 찾아 표로 정리해 줘. 시세 조회가 안 되면 그렇다고 솔직히 말해 줘. 투자 조언은 하지 마.",
    asksFirst: true,
    skills: ["k_stock", "k_news"],
  },
  {
    id: "outlet-trip",
    category: "shopping",
    title: "주말에 갈 만한 아울렛, 가는 길까지 찾아 드릴게요",
    description: "출발지에서 가까운 아울렛·대형마트를 찾고 차로 얼마나 걸리는지 알려 드려요.",
    icon: "bag",
    hue: 330,
    prompt: "주말에 갈 만한 아울렛이나 대형마트를 찾아 줘.",
    hint:
      "출발지를 모르면 먼저 물어봐. k_place_search로 가까운 아울렛·대형마트를 찾고, 가장 가까운 2~3곳은 k_directions로 자동차 이동 시간과 거리를 알려 줘. 영업시간처럼 확인이 안 된 정보는 확인이 필요하다고 표시해 줘.",
    asksFirst: true,
    skills: ["k_place_search", "k_directions"],
  },
  {
    id: "jeju-trip",
    category: "travel",
    title: "제주 2박 3일 일정 문서로 만들어 드릴게요",
    description: "날씨와 가볼 만한 곳을 확인해 동선에 맞춘 2박 3일 일정을 문서로 정리해 보관함에 넣어 드려요.",
    icon: "plane",
    hue: 190,
    prompt: "제주 2박 3일 여행 일정을 문서로 만들어 줘.",
    hint:
      "여행 날짜, 함께 가는 사람, 좋아하는 스타일(맛집·자연·카페 등)을 모르면 먼저 한 번에 짧게 물어봐. 그다음 k_weather로 제주 날씨를 확인하고 k_place_search로 지역별 가볼 만한 곳과 맛집을 찾아, 동쪽·서쪽 동선이 겹치지 않게 하루씩 일정을 짜 줘. 완성되면 sys_create_artifact로 '제주 2박 3일 일정' 문서(kind: document, 마크다운, 날짜별 일정표와 준비물 체크리스트 포함)를 만들어 보관함에 저장해 줘.",
    asksFirst: true,
    skills: ["k_weather", "k_place_search", "sys_create_artifact"],
  },
  {
    id: "holiday-plan",
    category: "travel",
    title: "올해 공휴일로 연차 계획 짜 드릴게요",
    description: "남은 공휴일을 확인해 연차를 가장 적게 쓰고 가장 길게 쉴 수 있는 날을 찾아 드려요.",
    icon: "calendar",
    hue: 10,
    prompt: "남은 공휴일을 보고 연차 계획을 짜 줘.",
    hint:
      "남은 연차 일수를 모르면 먼저 물어봐. k_holidays로 오늘 이후 남은 공휴일(내년 상반기 포함)을 조회하고, 주말과 이어 붙여 연차를 가장 적게 쓰고 가장 길게 쉴 수 있는 조합을 3가지 추천해 줘.",
    asksFirst: true,
    skills: ["k_holidays"],
  },
  {
    id: "travel-safety",
    category: "travel",
    title: "해외여행 안전 정보 확인해 드릴게요",
    description: "외교부 여행경보와 안전 공지로 가려는 나라의 안전 정보를 정리해 드려요.",
    icon: "shield",
    hue: 222,
    prompt: "해외여행 안전 정보를 확인해 줘.",
    hint:
      "가려는 나라를 모르면 먼저 물어봐. k_travel_safety로 그 나라의 외교부 여행경보 단계와 최근 안전 공지를 조회해, 주의할 지역과 미리 준비할 것을 정리해 줘.",
    asksFirst: true,
    skills: ["k_travel_safety"],
  },
  {
    id: "kakao-unread",
    category: "people",
    title: "카카오톡 안 읽은 대화 요약해 드릴게요",
    description: "연결된 카카오톡에서 안 읽은 대화를 모아 누가 무슨 말을 했는지, 답장이 필요한 것만 골라 정리해요.",
    icon: "kakao",
    hue: 50,
    prompt: "카카오톡에서 안 읽은 대화를 요약해 줘.",
    hint:
      "msg_list_chats로 kakaotalk의 대화방을 확인하고, 안 읽은 메시지가 많은 순서로 최대 5개 방을 msg_read로 읽어 줘. 방마다 누가 무슨 이야기를 했는지 한두 줄로 요약하고, 내가 답장해야 할 것만 따로 표시해 줘. 답장은 내가 부탁할 때만 보내 줘.",
    skills: ["msg_list_chats", "msg_read"],
  },
  {
    id: "slack-digest",
    category: "people",
    title: "슬랙 채널 요약해 드릴게요",
    description: "연결된 슬랙에서 오늘 오간 대화를 채널별로 요약하고, 나를 찾는 메시지를 먼저 보여 드려요.",
    icon: "slack",
    hue: 280,
    prompt: "슬랙 채널을 요약해 줘.",
    hint:
      "msg_list_chats로 slack 채널 목록을 보고, 활동이 많은 채널 최대 5개를 msg_read로 읽어 줘. 채널별로 오늘 오간 핵심 내용을 2~3줄로 요약하고, 나를 언급했거나 내 결정이 필요한 메시지를 맨 위에 정리해 줘. 메시지는 보내지 마.",
    skills: ["msg_list_chats", "msg_read"],
  },
  {
    id: "friend-relay",
    category: "people",
    title: "친구의 모시에게 말 전해 드릴게요",
    description: "모시 친구에게 약속이나 부탁을 정중하게 대신 전해 드려요.",
    icon: "people",
    hue: 345,
    prompt: "모시 친구에게 말을 전해 줘.",
    hint:
      "어떤 친구에게 무슨 말을 전할지 모르면 먼저 물어봐. 친구가 정해지면 sys_friend_message로 내 모시가 대신 전한다는 말투로 정중하게 전해 줘.",
    asksFirst: true,
    skills: ["sys_friend_message"],
  },
  {
    id: "weekend-shows",
    category: "culture",
    title: "이번 주말 서울 공연 찾아 드릴게요",
    description: "공연예술통합전산망(KOPIS)에서 이번 주말 서울에서 볼 수 있는 연극·뮤지컬·콘서트를 찾아 정리해요.",
    icon: "film",
    hue: 300,
    prompt: "이번 주말에 서울에서 볼 수 있는 공연을 찾아 줘.",
    hint:
      "k_performances로 이번 주 토요일·일요일에 서울에서 공연 중인 연극, 뮤지컬, 콘서트를 조회하고, 장르별로 3개씩 골라 공연명·장소·기간을 정리해 줘. 마지막에 더 보고 싶은 장르가 있는지 물어봐.",
    skills: ["k_performances"],
  },
  {
    id: "library-books",
    category: "culture",
    title: "읽고 싶은 책, 동네 도서관에서 찾아 드릴게요",
    description: "읽고 싶은 책이 가까운 공공도서관에 있는지, 지금 빌릴 수 있는지 찾아 드려요.",
    icon: "doc",
    hue: 28,
    prompt: "도서관에서 책을 찾아 줘.",
    hint:
      "책 제목과 사는 지역을 모르면 먼저 물어봐. k_library_books로 그 책을 가진 공공도서관과 대출 가능 여부를 조회해 가까운 곳부터 정리해 줘.",
    asksFirst: true,
    skills: ["k_library_books"],
  },
  {
    id: "han-river",
    category: "culture",
    title: "오늘 한강 산책하기 좋은지 알려 드릴게요",
    description: "한강 정보와 날씨·미세먼지를 확인하고, 따릉이 대여소 현황까지 챙겨 드려요.",
    icon: "wave",
    hue: 198,
    prompt: "오늘 한강 산책하기 좋은지 알려 줘.",
    hint:
      "가고 싶은 한강공원을 모르면 먼저 물어봐. k_han_river로 한강 정보를, k_weather로 서울 날씨를, k_fine_dust로 미세먼지를 확인하고, 따릉이를 탈 거라면 k_seoul_bike로 가까운 대여소의 자전거 현황도 알려 줘.",
    asksFirst: true,
    skills: ["k_han_river", "k_weather", "k_fine_dust", "k_seoul_bike"],
  },
  {
    id: "subway-commute",
    category: "home",
    title: "퇴근길 지하철 도착 알려 드릴게요",
    description: "타는 역과 방향만 알려 주시면 실시간 도착 정보로 다음 열차 시간을 알려 드려요. 매일 퇴근 시간에 맞춰 알려 드릴 수도 있어요.",
    icon: "train",
    hue: 140,
    prompt: "퇴근길 지하철 도착 정보를 알려 줘.",
    hint:
      "내가 타는 역 이름과 호선·방향을 모르면 먼저 물어봐(수도권 지하철만 지원돼). 역을 알면 k_subway_arrival로 실시간 도착 정보를 확인해 다음 열차 두 대의 도착 예정 시간을 알려 줘. 그리고 매일 퇴근 시간에 자동으로 알려 줄지 물어보고, 원하면 sys_schedule_create로 평일 일정(weekly@1,2,3,4,5@HH:MM)을 만들어 줘.",
    asksFirst: true,
    skills: ["k_subway_arrival", "sys_schedule_create"],
  },
  {
    id: "airport-drive",
    category: "travel",
    title: "공항까지 차로 얼마나 걸리는지 알려 드릴게요",
    description: "출발지에서 공항까지 자동차(택시) 기준 이동 시간과 거리를 알려 드려요.",
    icon: "map",
    hue: 22,
    prompt: "강남역에서 김포공항까지 택시 얼마나 걸려?",
    hint:
      "출발지와 공항이 다르면 먼저 물어보고, k_directions로 자동차 기준 이동 시간과 거리를 알려 줘. 비행기 시간을 말해 주면 몇 시에 출발하면 좋을지도 계산해 줘.",
    skills: ["k_directions"],
  },
  {
    id: "fine-dust",
    category: "home",
    title: "미세먼지 보고 외출해도 될지 알려 드릴게요",
    description: "지금 동네 미세먼지와 날씨를 확인해 마스크가 필요한지, 외출하기 좋은 시간을 알려 드려요.",
    icon: "cloud",
    hue: 182,
    prompt: "지금 미세먼지랑 날씨를 보고 외출해도 되는지 알려 줘.",
    hint:
      "내 동네를 모르면 먼저 물어봐. k_fine_dust로 미세먼지·초미세먼지 등급을, k_weather로 오늘 시간대별 날씨를 확인해서 마스크가 필요한지와 외출하기 좋은 시간대를 알려 줘. 미세먼지 조회가 안 되면 날씨만으로 알려 줘.",
    asksFirst: true,
    skills: ["k_fine_dust", "k_weather"],
  },
  {
    id: "apt-prices",
    category: "home",
    title: "우리 동네 아파트 실거래가 알려 드릴게요",
    description: "국토교통부 실거래가로 우리 동네 아파트가 최근 얼마에 거래됐는지 정리해 드려요.",
    icon: "house",
    hue: 100,
    prompt: "우리 동네 아파트 실거래가를 알려 줘.",
    hint:
      "동네(시·군·구와 동)나 관심 있는 단지 이름을 모르면 먼저 물어봐. k_real_estate로 최근 3개월 실거래 내역을 조회해 단지별 거래가·면적·거래일을 정리하고, 가격 흐름을 한 줄로 요약해 줘.",
    asksFirst: true,
    skills: ["k_real_estate"],
  },
  {
    id: "school-lunch",
    category: "home",
    title: "아이 학교 급식 알려 드릴게요",
    description: "학교 이름만 알려 주시면 오늘과 이번 주 급식 메뉴를 알려 드려요.",
    icon: "heart",
    hue: 118,
    prompt: "아이 학교 급식 메뉴를 알려 줘.",
    hint:
      "학교의 정식 이름(예: 서울대치초등학교)을 모르면 먼저 물어봐. k_school_lunch로 오늘 급식과 이번 주 메뉴를 조회해 정리하고, 알레르기 정보가 있으면 함께 표시해 줘. 매일 아침 알려 줄지도 물어봐.",
    asksFirst: true,
    skills: ["k_school_lunch"],
  },
  {
    id: "law-easy",
    category: "home",
    title: "생활 속 궁금한 법, 쉽게 풀어 드릴게요",
    description: "전세·근로·소비자 문제처럼 생활 속 궁금한 법령을 찾아 쉬운 말로 설명해 드려요.",
    icon: "doc",
    hue: 255,
    prompt: "생활 속 법 문제를 쉽게 설명해 줘.",
    hint:
      "어떤 상황인지 먼저 물어보고, k_law_search로 관련 법령 조문을 찾아 핵심 내용을 쉬운 말로 풀어 줘. 법률 자문이 아니라 참고 정보라는 점도 짧게 알려 줘.",
    asksFirst: true,
    skills: ["k_law_search"],
  },
  {
    id: "housing-notices",
    category: "benefit",
    title: "지금 모집 중인 행복주택·임대 공고 찾아 드릴게요",
    description: "LH 청약·임대 공고 중 지금 접수 중인 것만 지역별로 골라 마감 순으로 알려 드려요.",
    icon: "house",
    hue: 52,
    prompt: "서울 행복주택 모집하는 거 있어?",
    hint:
      "관심 지역이 다르면 먼저 물어보고, k_housing_notices로 지금 접수 중인 공고를 찾아 공고명·지역·마감일을 마감 순으로 정리해 줘.",
    skills: ["k_housing_notices"],
  },
  {
    id: "crowd-check",
    category: "culture",
    title: "가려는 곳, 지금 사람 많은지 알려 드릴게요",
    description: "서울 주요 장소의 실시간 혼잡도를 보고 지금 가도 괜찮은지 알려 드려요. (서울만 지원)",
    icon: "people",
    hue: 280,
    prompt: "지금 성수 카페거리 사람 많아?",
    hint:
      "다른 곳이 궁금하면 장소를 먼저 물어보고, k_seoul_density로 실시간 혼잡도를 확인해서 지금 가도 괜찮은지, 덜 붐비는 시간이 언제쯤일지 알려 줘. 서울 밖이면 지원하지 않는다고 말해 줘.",
    skills: ["k_seoul_density"],
  },
  // ───── personalised suggestions (hidden from the gallery) ─────
  {
    id: "suggest-wakeup",
    category: "suggestion",
    title: "일어나야 하는 시간에 맞춰 {displayName}님께 모닝콜 브리핑을 보내 드릴게요.",
    description: "매일 일어날 시간에 먼저 말을 걸어 날씨와 오늘 할 일을 챙겨 드려요.",
    icon: "clock",
    hue: 15,
    prompt: "매일 아침 일어날 시간에 맞춰 모닝콜 겸 브리핑을 보내 줘.",
    hint:
      "몇 시에 일어나는지, 평일만인지 먼저 물어봐. 정해지면 sys_schedule_create로 그 시간에 '좋은 아침 인사와 함께 오늘 날씨(k_weather)와 오늘 일정을 짧게 알려 주는' 예약을 만들어 줘.",
    asksFirst: true,
    skills: ["sys_schedule_create", "k_weather"],
    hidden: true,
  },
  {
    id: "connect-kakao",
    category: "suggestion",
    title: "카카오톡을 연결하면 놓친 대화를 대신 정리해 드릴게요.",
    description: "카카오톡을 연결해 두면 {agentName}에게 안 읽은 대화 요약이나 답장을 맡길 수 있어요.",
    icon: "kakao",
    hue: 50,
    prompt: "카카오톡을 연결해서 안 읽은 대화를 요약해 줘.",
    hint:
      "msg_list_chats로 kakaotalk 대화방을 확인해 줘.",
    skills: ["msg_list_chats", "msg_read"],
    hidden: true,
  },
];

export function seedTemplates(core: Core): void {
  core.db.tx(() => {
    const live = new Set(TEMPLATE_SEEDS.map((t) => t.id));
    for (const t of core.db.listTemplates(true)) if (!live.has(t.id)) core.db.hideTemplate(t.id);
    TEMPLATE_SEEDS.forEach((t, i) =>
      core.db.upsertTemplate({
        id: t.id,
        category: t.category,
        title: t.title,
        description: t.description,
        icon: t.icon,
        hue: t.hue,
        prompt: t.prompt,
        skills: t.skills,
        sort: i,
        hidden: !!t.hidden,
      }),
    );
  });
}

function render(text: string, user: UserRow): string {
  return text.replaceAll("{displayName}", user.display_name).replaceAll("{agentName}", user.agent_name);
}

const SEED_BY_ID = new Map(TEMPLATE_SEEDS.map((t) => [t.id, t]));

/** heads a template's hint in the model copy: the person's screen shows only their line above it */
export const TEMPLATE_HINT_HEAD = "(둘러보기에서 맡긴 일이라 앱이 진행 방법을 덧붙였어요. 사용자 화면에는 위 한 줄만 보여요.)";

/**
 * The model-only note for a first message whose text is a template's line (the caller checks it is the first message
 * of the person's own new task thread), else null. Matching the text, not a template id on the request, keeps the
 * hint on every way the app sends that line: 부탁하기, its retry after a refused send, the island's 다시 시도.
 */
export function templateHint(user: UserRow, text: string): string | null {
  const seed = TEMPLATE_SEEDS.find((t) => t.hint && render(t.prompt, user) === text);
  return seed ? `${TEMPLATE_HINT_HEAD}\n${render(seed.hint!, user)}` : null;
}

export function templateView(t: TemplateRow, user: UserRow): TaskTemplate {
  return {
    id: t.id,
    category: t.category,
    title: render(t.title, user),
    description: render(t.description, user),
    icon: t.icon,
    hue: t.hue,
    prompt: render(t.prompt, user),
    asksFirst: !!SEED_BY_ID.get(t.id)?.asksFirst,
    count: t.count,
    skills: safeJson(t.skills_json, []),
  };
}

async function suggestionIds(core: Core, user: UserRow): Promise<string[]> {
  const ids: string[] = [];
  const hour = kstParts(core.now()).hour;
  if (hour >= 5 && hour < 11) ids.push("morning-briefing");
  if (hour >= 16 && hour < 21) ids.push("subway-commute");
  let kakaoConnected = false;
  try {
    kakaoConnected = (await core.deps.hub.connections(user.id)).some((c) => c.provider === "kakaotalk" && c.status === "connected");
  } catch {
    kakaoConnected = false;
  }
  if (!kakaoConnected) ids.push("connect-kakao");
  if (core.db.listSchedules(user.id).length === 0) ids.push("suggest-wakeup");
  for (const fill of ["gov-benefits", "weekend-shows", "news-briefing"]) if (ids.length < 3) ids.push(fill);
  return [...new Set(ids)].slice(0, 4);
}

export function exploreRoutes(core: Core) {
  return {
    explore: async (_c: Ctx, userId: string) => {
      const user = core.db.userById(userId)!;
      const popular = core.db.listTemplates(false).map((t) => templateView(t, user));
      const suggestions: TaskTemplate[] = [];
      for (const id of await suggestionIds(core, user)) {
        const t = core.db.getTemplate(id);
        if (t) suggestions.push(templateView(t, user));
      }
      const res: ExploreResponse = { categories: CATEGORIES, popular, suggestions };
      return json(res);
    },

    delegate: (c: Ctx, userId: string) => {
      const t = core.db.getTemplate(c.params.templateId!);
      if (!t) throw notFound("작업을 찾을 수 없어요", "template_not_found");
      const user = core.db.userById(userId)!;
      const view = templateView(t, user);
      const now = core.now();
      const id = newId("t");
      const isCall = t.id === "call-demo";
      core.db.createThread(
        {
          id,
          ownerId: userId,
          kind: isCall ? "call" : "task",
          title: isCall ? `${user.display_name}님께 전화` : view.title,
          subtitle: isCall ? `${user.agent_name}의 외부 통화` : `${user.agent_name}에게 맡긴 일`,
          icon: isCall ? "phone" : view.icon,
          now,
        },
        [userId],
      );
      if (isCall) {
        // static opener from the agent (no LLM call, no quota); prompt stays "" so the client
        // waits for the user's answer instead of auto-sending
        core.db.insertMessage({
          id: newId("m"),
          threadId: id,
          role: "assistant",
          text: CALL_DEMO_GREETING,
          llm: [{ role: "assistant", content: CALL_DEMO_GREETING }],
          createdAt: now + 1,
        });
      }
      core.db.incrementTemplate(t.id);
      publishThread(core, id); // every device of the person lists it at once (this one has it from the 201), not at the first answer
      const res: DelegateResponse = { thread: threadViewById(core, id, userId)!, prompt: view.prompt };
      return json(res, 201);
    },
  };
}
