/**
 * Real tool name → Korean status text and data source (MOTION-SPEC §8.3/§8.5, research §3-0 rule 2).
 * Unknown tools say "작업하는 중" — never a rotating made-up phrase. Tool names are the server's
 * (packages/skills k_*, agent-messenger msg_*, system sys_*).
 */
const LABELS: Record<string, string> = {
  k_weather: "날씨 보는 중",
  k_fine_dust: "미세먼지 보는 중",
  k_news: "뉴스 찾는 중",
  k_place_search: "장소 찾는 중",
  k_shopping: "가격 비교하는 중",
  k_directions: "길 찾는 중",
  k_subway_arrival: "지하철 도착 정보 보는 중",
  k_seoul_bike: "따릉이 찾는 중",
  k_seoul_density: "혼잡도 보는 중",
  k_han_river: "한강 정보 보는 중",
  k_stock: "주가 보는 중",
  k_real_estate: "부동산 시세 보는 중",
  k_gov_support: "지원사업 찾는 중",
  k_housing_notices: "주택 공고 찾는 중",
  k_law_search: "법령 찾는 중",
  k_gas_prices: "주유소 가격 보는 중",
  k_holidays: "공휴일 확인하는 중",
  k_travel_safety: "여행 안전 정보 보는 중",
  k_school_lunch: "급식 메뉴 보는 중",
  k_performances: "공연 찾는 중",
  k_library_books: "도서관 책 찾는 중",
  msg_read: "메시지 읽는 중",
  msg_send: "메시지 보내는 중",
  msg_list_chats: "대화방 살펴보는 중",
  msg_connections: "메신저 연결 확인하는 중",
  sys_web_fetch: "웹 페이지 읽는 중",
  web_search: "웹 찾는 중",
  web_read: "페이지 읽는 중",
  sys_time: "시간 확인하는 중",
  sys_show_briefing: "브리핑 정리하는 중",
  sys_schedule_list: "일정 확인하는 중",
  sys_schedule_create: "일정 만드는 중",
  sys_schedule_delete: "일정 지우는 중",
  sys_remember: "기억하는 중",
  sys_recall: "기억 떠올리는 중",
  sys_phone_call: "전화 거는 중",
  sys_call_me: "전화 거는 중", // the agent calls the user's own phone
  sys_friends_list: "친구 목록 보는 중",
  sys_friend_message: "친구에게 보내는 중",
  sys_create_artifact: "문서 만드는 중",
};

const SOURCES: Record<string, string> = {
  k_weather: "기상청",
  k_fine_dust: "에어코리아",
  k_place_search: "카카오맵",
  k_subway_arrival: "서울교통공사",
  k_seoul_bike: "서울 열린데이터광장",
  k_seoul_density: "서울 실시간 도시데이터",
  k_stock: "한국거래소",
  k_law_search: "국가법령정보센터",
  k_gas_prices: "오피넷",
  k_school_lunch: "NEIS",
  k_performances: "KOPIS",
  sys_web_fetch: "웹",
  web_read: "웹",
};

const MESSENGERS: [RegExp, string][] = [
  [/카카오|kakao/i, "카카오톡"],
  [/라인|\bline\b/i, "LINE"],
  [/텔레그램|telegram/i, "텔레그램"],
  [/인스타|instagram/i, "인스타그램"],
  [/팀즈|teams/i, "Teams"],
  [/슬랙|slack/i, "Slack"],
  [/디스코드|discord/i, "Discord"],
];

function messengerIn(title?: string) {
  if (!title) return undefined;
  for (const [re, name] of MESSENGERS) if (re.test(title)) return name;
  return undefined;
}

/** normalise "k.weather" / "k-weather" to the server's k_weather */
const norm = (name: string) => name.trim().replace(/[.-]/g, "_");

/**
 * Status text for a running tool: `k_weather` → "날씨 보는 중"; unknown → "작업하는 중". msg_* name the messenger
 * when the server's title says which ("카카오톡 대화 읽기" → "카카오톡 읽는 중"), else "메시지 읽는 중".
 */
export function toolLabel(name: string, title?: string): string {
  const n = norm(name);
  const m = n.startsWith("msg_") ? messengerIn(title) : undefined;
  if (n === "msg_read" && m) return `${m} 읽는 중`;
  if (n === "msg_send" && m) return `${m} 보내는 중`;
  if (n === "msg_list_chats" && m) return `${m} 대화방 보는 중`;
  return LABELS[n] ?? "작업하는 중";
}

/** where a step's data came from (tool chip expansion), or undefined */
export function toolSource(name: string, title?: string): string | undefined {
  const n = norm(name);
  if (n.startsWith("msg_")) return messengerIn(title) ?? "메신저";
  return SOURCES[n];
}

/** "12초", "1분 33초", "2분" — how long something took, in Korean (a second at least) */
export function durationKo(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}분 ${r}초` : `${m}분`;
}

/** "4단계 · 12초", "2단계 · 1분 33초" — the folded tool-chip summary after done */
export function stepsSummary(count: number, ms: number): string {
  return `${count}단계 · ${durationKo(ms)}`;
}
