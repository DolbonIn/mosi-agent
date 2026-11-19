import type { Connection, ConnectionStatus, CredentialField, LoginMethod, ProviderCategory, ProviderInfo } from "@pickle/protocol";
import type { PillTone } from "../parts";

/** Korean copy for the connections screen: capabilities, statuses, example prompts per provider. */

export const CAPABILITY: Record<ProviderInfo["capabilities"][number], string> = {
  read: "대화 읽기",
  send: "허락받은 메시지 보내기",
  list: "대화방 목록 보기",
  search: "대화 검색하기",
};

/** the same four, short, for the sheet's summary row ("목록 보기 · 읽기 · 허락받은 메시지 보내기 · 검색") */
export const CAPABILITY_SHORT: Record<ProviderInfo["capabilities"][number], string> = {
  read: "읽기",
  send: "허락받은 메시지 보내기",
  list: "목록 보기",
  search: "검색",
};

/** what the agent never does, whatever the provider: the one line that closes the list (the other two "never"s were
 *  the list read backwards: sending only what was allowed, and the sealed password said under the password field) */
export const CANNOT_LINE = "친구 추가·삭제나 설정은 바꾸지 않아요.";

/** the connections screen's title (messengers now, the agent's login-based services next); the rows that push it
 *  (나의 모시, 둘러보기, 저장된 로그인) use the same words so the label morphs into the large title */
export const CONNECTIONS_TITLE = "앱 연결";

/** login rows, chunked by where they're used (draft connections B); ids keep this order */
export const LOGIN_GROUPS: { title: string; ids: string[] }[] = [
  { title: "일상 메신저", ids: ["kakaotalk", "instagram", "line", "telegram", "discord"] },
  { title: "업무 메신저", ids: ["slack", "teams", "webex"] },
];

/** a provider the groups above don't name yet falls into its category */
export const CATEGORY_TITLE: Record<ProviderCategory, string> = {
  messenger: "다른 메신저",
  service: "서비스",
  korea: "국내 서비스",
};
export const CATEGORY_ORDER: ProviderCategory[] = ["messenger", "service", "korea"];

/** how the row says you connect (protocol `login`); old servers without it fall back to `auth` */
const LOGIN_COPY: Record<LoginMethod, string> = {
  relay_code: "이메일 코드로 로그인",
  remote_auth: "앱에서 승인해 로그인",
  phone_code: "전화번호로 로그인",
  password: "계정으로 로그인",
  device_code: "회사 계정으로 로그인",
  bot_token: "봇 토큰으로 연결",
};
export function loginCopy(p: ProviderInfo): string {
  if (p.login && LOGIN_COPY[p.login]) return LOGIN_COPY[p.login];
  return p.auth === "oauth" ? "회사 계정으로 로그인" : p.auth === "api_key" ? "API 키로 연결" : p.auth === "token" ? "토큰으로 연결" : "계정으로 로그인";
}

/**
 * The vault kind the device seals a provider's fields as (aad `${userId}:${id}:${kind}`); the server refuses a save sealed
 * as any other kind. The provider's own `kind` wins (every k-skill service sends it: auth "api_key" is "token"); without
 * it, auth "token" or "api_key" is a token and anything else a login (the messenger logins, exactly as before).
 */
export function sealKind(p: Pick<ProviderInfo, "auth" | "kind">): "login" | "token" {
  return p.kind ?? (p.auth === "token" || p.auth === "api_key" ? "token" : "login");
}

/** a connection that belongs in the "연결됨" section */
export function isLinked(c: Connection | undefined): c is Connection {
  if (!c) return false;
  if (c.status === "connected" || c.status === "needs_verification" || c.status === "connecting") return true;
  return c.status === "error" && !!c.accountLabel;
}

export function statusPill(status: ConnectionStatus | undefined): { tone: PillTone; label: string } | null {
  switch (status) {
    case "connected":
      return { tone: "ok", label: "연결됨" };
    case "connecting":
      return { tone: "wait", label: "연결 중" };
    case "needs_verification":
      return { tone: "wait", label: "확인 필요" };
    case "error":
      return { tone: "error", label: "연결 안 됨" };
    default:
      return null;
  }
}

/** "이제 이렇게 부탁해 보세요" — prompts that need exactly this connection */
const EXAMPLES: Record<string, string[]> = {
  kakaotalk: ["카카오톡 안 읽은 대화 요약해 줘", "엄마한테 '오늘 조금 늦어요'라고 보내 줘", "단톡방에서 이번 주 약속 시간 찾아 줘"],
  slack: ["슬랙 오늘 대화 중 나한테 온 것만 정리해 줘", "팀 채널에 '회의 10분 늦어요'라고 보내 줘"],
  slackbot: ["봇이 있는 슬랙 채널 오늘 대화 요약해 줘", "공지 채널에 '배포 끝났어요'라고 보내 줘"],
  discord: ["디스코드 안 읽은 DM 정리해 줘", "서버 공지 채널 최근 글 요약해 줘"],
  telegram: ["텔레그램 안 읽은 대화 요약해 줘", "텔레그램으로 '지금 출발해요'라고 보내 줘"],
  discordbot: ["디스코드 서버 공지 채널 최근 글 요약해 줘", "일반 채널에 '오늘 모임 8시예요'라고 보내 줘"],
  telegrambot: ["텔레그램 봇에 온 메시지 정리해 줘", "텔레그램 봇으로 '확인했어요'라고 답장해 줘"],
  line: ["라인 안 읽은 대화 요약해 줘", "라인으로 '도착했어요'라고 보내 줘"],
  instagram: ["인스타그램 안 읽은 DM 정리해 줘", "인스타그램 DM에 '고마워요'라고 답장해 줘"],
  teams: ["Teams 오늘 채팅 요약해 줘", "팀 채팅방에 '자료 올렸어요'라고 보내 줘"],
  webex: ["Webex 스페이스 새 메시지 요약해 줘", "Webex 스페이스에 '곧 들어갈게요'라고 보내 줘"],
};
export const examplesFor = (p: ProviderInfo) => EXAMPLES[p.id] ?? [`${p.name} 새 소식 정리해 줘`];

export function inputModeFor(f: CredentialField): "email" | "tel" | "text" | undefined {
  if (f.type === "email") return "email";
  if (f.type === "tel") return "tel";
  return undefined;
}

export function autocompleteFor(f: CredentialField): string {
  if (f.autocomplete) return f.autocomplete;
  if (f.type === "password") return f.key === "password" ? "current-password" : "off";
  if (f.type === "email" || f.key === "username" || f.key === "email") return "username";
  return "off";
}

export const CHAT_KIND: Record<"dm" | "group" | "channel", string> = { dm: "1:1", group: "단체", channel: "채널" };
