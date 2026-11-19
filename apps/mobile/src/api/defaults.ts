import type { UiDefinitions } from "@pickle/protocol";

/**
 * Server-driven UI defaults (used before / without GET /api/ui-definitions). Korean copy matches the real app.
 */
export const DEFAULT_UI: UiDefinitions = {
  version: 0,
  tabs: [
    { id: "chat", title: "채팅", icon: "chat" },
    { id: "explore", title: "둘러보기", icon: "compass" },
    { id: "archive", title: "보관함", icon: "archive" },
    { id: "profile", title: "나의 모시", icon: "person" },
  ],
  drawer: [
    { id: "main", title: "기본 채팅", icon: "chat", target: "chat" },
    { id: "friends", title: "친구", icon: "people", target: "friends" },
    { id: "explore", title: "둘러보기", icon: "compass", target: "explore" },
    { id: "archive", title: "보관함", icon: "archive", target: "archive" },
    { id: "profile", title: "나의 모시", icon: "person", target: "profile" },
  ],
  composer: { placeholder: "무엇이든 맡겨보세요", attach: true, voice: true, call: true },
  explore: {
    title: "둘러보기",
    categories: [
      { id: "recommend", title: "추천", icon: "star" },
      { id: "benefit", title: "혜택", icon: "gift" },
      { id: "shopping", title: "쇼핑", icon: "bag" },
      { id: "travel", title: "여행", icon: "plane" },
      { id: "people", title: "사람", icon: "people" },
      { id: "culture", title: "문화", icon: "film" },
      { id: "home", title: "생활", icon: "house" },
    ],
  },
  archive: {
    segments: [
      { id: "artifacts", title: "아티팩트" },
      { id: "media", title: "미디어" },
    ],
    emptyArtifacts: "아직 만든 아티팩트가 없어요",
    emptyMedia: "아직 올린 미디어가 없어요",
  },
  profile: {
    sections: [
      // the server's order (apps/server/src/sdui.ts, my-mosi B): 사용량 · 내 계정 · agent · 개인 정보와 보안 · 앱 사용
      { id: "quota", title: "사용량", rows: [{ id: "quota", title: "일일 사용량 한도", icon: "bolt", target: "quota" }] },
      {
        id: "account",
        title: "내 계정",
        rows: [
          { id: "account", title: "내 계정", icon: "person", target: "account" },
          { id: "phone", title: "내 전화번호", icon: "phone", target: "phone" },
        ],
      },
      {
        id: "agent",
        title: "깽이",
        rows: [
          { id: "connections", title: "앱 연결", icon: "link", target: "connections" },
          { id: "schedules", title: "예약된 일", icon: "clock", target: "schedules" },
          { id: "friends", title: "친구", icon: "people", target: "friends" },
          { id: "privacy-scope", title: "정보 공개 범위", icon: "lock", target: "privacy-scope" },
        ],
      },
      {
        id: "security",
        title: "개인 정보와 보안",
        rows: [
          { id: "logins", title: "저장된 로그인", icon: "key", target: "logins" },
          { id: "payments", title: "결제 수단", icon: "card", target: "payments" },
          { id: "access-log", title: "접근 기록", icon: "eye", target: "access-log" },
          { id: "privacy", title: "개인 정보 보호", icon: "shield", target: "privacy" },
        ],
      },
      {
        id: "app",
        title: "앱 사용",
        rows: [
          { id: "notifications", title: "알림 설정", icon: "bell", target: "notifications" },
          { id: "display", title: "화면 및 디자인", icon: "paintbrush", target: "display" },
        ],
      },
    ],
  },
};
