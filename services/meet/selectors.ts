// Meet 화면 선택자. 클래스 이름 대신 aria-label·role·data 속성과 버튼 문구를 쓰고, 한국어·영어를 함께 둔다.
// 이 객체는 페이지 주입 스크립트에도 JSON으로 넘어가므로(probe) 정규식은 문자열로 둔다.

export const SELECTORS = {
  nameInput: [
    'input[aria-label="이름"]',
    'input[aria-label="Your name"]',
    'input[placeholder="이름"]',
    'input[placeholder="Your name"]',
  ].join(", "),
  /** 참여 버튼 문구(정확히 일치). ask = 호스트 수락 필요, now = 바로 들어감 */
  joinLabels: [
    { label: "참여 요청", kind: "ask" },
    { label: "참여 요청하기", kind: "ask" },
    { label: "지금 참여하기", kind: "now" }, // signed-in Workspace UI (2026-11-12)
    { label: "참여하기", kind: "now" },
    { label: "Ask to join", kind: "ask" },
    { label: "지금 참여", kind: "now" },
    { label: "Join now", kind: "now" },
    { label: "참여", kind: "now" },
    { label: "Join", kind: "now" },
  ] as { label: string; kind: "ask" | "now" }[],
  leaveButton: [
    'button[aria-label^="통화에서 나가기"]',
    'button[aria-label^="Leave call"]',
    '[role="button"][aria-label^="통화에서 나가기"]',
    '[role="button"][aria-label^="Leave call"]',
  ].join(", "),
  /** 나가기 버튼의 아이콘 글꼴 문구(언어와 무관) */
  leaveIcon: "call_end",
  /** data-is-muted가 붙은 토글 버튼의 aria-label에 들어가는 낱말 */
  micWords: ["마이크", "microphone"],
  camWords: ["카메라", "camera"],
  /** aria-label이 다른 언어일 때 대신 보는 아이콘 글꼴 문구 */
  micIcons: ["mic", "mic_off", "mic_none"],
  camIcons: ["videocam", "videocam_off"],
  /** 참여 전 화면의 "Google 계정으로 로그인" 말풍선 같은 안내를 닫는 버튼 */
  dismissLabels: ["확인", "Got it", "닫기", "Dismiss", "나중에", "Not now"], // "나중에": the 1080p promo on the signed-in pre-join
  /** 참석자 수 배지가 붙은 '사용자' 버튼 */
  peopleButtonRe: "모든 사용자|사용자 보기|참여자|People|participants|Show everyone",
  /** 안내 문구 → 신호 키(문구 원문은 노드로 넘어오지 않는다) */
  signals: {
    cant_join: "이 화상 통화에 참여할 수 없습니다|통화에 참여할 수 없습니다|You can.t join this (video )?call|can.t join this call",
    denied: "참여 요청이 거부|요청이 거부되었습니다|요청을 거부했습니다|denied your request|request to join was denied|Someone in the call denied",
    no_response: "요청에 응답한 사람이 없습니다|아무도 응답하지 않았습니다|No one responded to your request|No one has responded",
    invalid: "회의 코드를 확인|Check your meeting code|잘못된 화상 통화|Invalid video call name|화상 통화를 찾을 수 없습니다|Couldn.t find (the|this) (meeting|call)|존재하지 않는 회의",
    meeting_ended: "회의가 종료되었습니다|통화가 종료되었습니다|The meeting has ended|The call has ended|ended the (meeting|call) for everyone|모든 사용자의 (회의|통화)를 종료",
    removed: "회의에서 삭제되었습니다|통화에서 삭제되었습니다|나를 (회의|통화)에서 삭제|You.ve been removed|removed you from the (meeting|call)|내보냈습니다",
    left: "회의에서 나갔습니다|통화에서 나갔습니다|You left the meeting|You.ve left the (meeting|call)",
    waiting: "참여 요청 중|참여를 요청하는 중|참여를 요청하고 있습니다|누군가 참여를 허락하면|Asking to be let in|when someone lets you in|Please wait until a meeting host brings you",
    full: "통화 인원이 가득|참여 인원이 가득|This call is full|call is full",
    alone: "You.re the only one here|혼자 있습니다|참여자가 나뿐|다른 참여자가 없습니다",
  } as Record<string, string>,
};

export type SignalKey = keyof typeof SELECTORS.signals;

/** 버튼 문구 정규식(정확 일치) */
export function exactLabelRe(labels: string[]): RegExp {
  return new RegExp(`^\\s*(?:${labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*$`);
}
