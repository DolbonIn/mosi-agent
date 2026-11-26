/** Server-driven UI definitions (GET /api/ui-definitions), personalised with the agent's name. */
import type { UiDefinitions } from "@pickle/protocol";
import { CATEGORIES } from "./explore.ts";

export const UI_VERSION = 2;

export function uiDefinitions(agentName: string): UiDefinitions {
  return {
    version: UI_VERSION,
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
    composer: { placeholder: "메시지 보내기", attach: true, voice: true, call: true },
    explore: { title: "둘러보기", categories: CATEGORIES },
    archive: {
      segments: [
        { id: "artifacts", title: "문서" },
        { id: "media", title: "사진·파일" },
      ],
      emptyArtifacts: `아직 만든 문서가 없어요\n${agentName}하고 함께 필요한 문서나 대시보드를 만들어 보세요.`,
      emptyMedia: "아직 올린 사진이나 파일이 없어요\n여기에서 올리거나 대화에서 + 버튼으로 보내면 여기에 모여요.",
    },
    // 나의 모시 B: what it costs, who I am, what my agent does, what it may see; then app settings
    profile: {
      sections: [
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
          title: agentName,
          rows: [
            { id: "connections", title: "앱 연결", icon: "link", target: "connections" },
            { id: "schedules", title: "예약된 일", icon: "clock", target: "schedules" },
            { id: "invest", title: "투자", icon: "chart", target: "invest" },
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
}
