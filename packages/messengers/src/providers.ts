/**
 * Provider catalog (stable ids). `auth` tells the client which credential kind to seal:
 * "credentials" → kind "login", "token" → kind "token", "oauth" → no credential (device code).
 * `login` says which sign-in the connect sheet runs (protocol LoginMethod): the in-app relays (Slack email code,
 * Discord app approval, Telegram phone login) never ask for a token; `advanced` bots (bot tokens the person made
 * themselves) are listed apart, under "고급 · 직접 만든 봇 연결".
 */
import type { CredentialField, ProviderInfo } from "@pickle/protocol";
import { telegramAppFromEnv } from "./login/telegram";
import { SDK_SUBPATH, type SdkFactories } from "./sdk";
import { tdjsonAvailable } from "./tdlib/runtime";

export type ProviderId = keyof SdkFactories;
export const PROVIDER_IDS: readonly ProviderId[] = [
  "kakaotalk",
  "slack",
  "slackbot",
  "discord",
  "discordbot",
  "telegram",
  "telegrambot",
  "line",
  "instagram",
  "teams",
  "webex",
];

export function isProviderId(id: unknown): id is ProviderId {
  return typeof id === "string" && (PROVIDER_IDS as readonly string[]).includes(id);
}

const pw = (label = "비밀번호"): CredentialField => ({ key: "password", label, type: "password", autocomplete: "current-password" });

type CatalogEntry = Omit<ProviderInfo, "available" | "unavailableReason">;

const CATALOG: Record<ProviderId, CatalogEntry> = {
  kakaotalk: {
    id: "kakaotalk",
    name: "카카오톡",
    category: "messenger",
    icon: "kakao",
    hue: 50,
    auth: "credentials",
    login: "password",
    fields: [
      {
        key: "email",
        label: "카카오계정 (이메일)",
        type: "email",
        autocomplete: "username",
        placeholder: "example@kakao.com",
        hint: "2단계 인증을 켠 계정은 아직 연결할 수 없어요.",
      },
      pw(),
    ],
    description:
      "카카오계정으로 로그인해 대화방을 읽고, 허락받은 메시지를 대신 보내요. 태블릿 기기로 로그인돼서 휴대폰·PC 카카오톡은 그대로 쓸 수 있어요.",
    capabilities: ["list", "read", "send", "search"],
  },
  slack: {
    id: "slack",
    name: "슬랙",
    category: "messenger",
    icon: "slack",
    hue: 300,
    auth: "token",
    login: "relay_code",
    fields: [
      { key: "token", label: "토큰 (xoxc-…)", type: "password", autocomplete: "off", placeholder: "xoxc-…" },
      { key: "cookie", label: "쿠키 d 값 (xoxd-…)", type: "password", autocomplete: "off", placeholder: "xoxd-…" },
    ],
    description:
      // shown on the "고급: 토큰 직접 입력" form; the default path is the in-app Slack sign-in (POST /api/connections/slack/login)
      "Slack 로그인이 안 될 때(회사 SSO 등) 쓰는 방법이에요. PC 브라우저에서 Slack에 로그인한 뒤 개발자 도구를 열어 ① Application(저장소) → Cookies → app.slack.com 의 'd' 값(xoxd-…)과 ② Console에서 JSON.parse(localStorage.localConfig_v2).teams 안의 token 값(xoxc-…)을 붙여 넣어 주세요.",
    capabilities: ["list", "read", "send", "search"],
  },
  slackbot: {
    id: "slackbot",
    name: "슬랙 봇",
    category: "messenger",
    icon: "slack",
    hue: 310,
    auth: "token",
    login: "bot_token",
    advanced: true,
    fields: [{ key: "token", label: "봇 토큰 (xoxb-…)", type: "password", autocomplete: "off", placeholder: "xoxb-…" }],
    description:
      "직접 만든 Slack 앱의 봇으로 연결해요. api.slack.com/apps → OAuth & Permissions에서 Bot User OAuth Token(xoxb-…)을 복사해 주세요. 봇이 초대된 채널만 읽고 보낼 수 있어요.",
    capabilities: ["list", "read", "send", "search"],
  },
  discord: {
    id: "discord",
    name: "디스코드",
    category: "messenger",
    icon: "discord",
    hue: 235,
    auth: "token",
    login: "remote_auth",
    // kept so a token connection made before the login relay still validates; the app no longer shows this field
    fields: [{ key: "token", label: "사용자 토큰", type: "password", autocomplete: "off" }],
    description:
      "디스코드 앱에서 '로그인'만 누르면 연결돼요. 비밀번호나 토큰은 입력하지 않아요. DM과 서버 채널을 읽고 보내요. 주의: 개인 계정 자동화는 디스코드 이용약관에 어긋나 계정이 제한될 수 있어요.",
    capabilities: ["list", "read", "send", "search"],
  },
  discordbot: {
    id: "discordbot",
    name: "디스코드 봇",
    category: "messenger",
    icon: "discord",
    hue: 240,
    auth: "token",
    login: "bot_token",
    advanced: true,
    fields: [{ key: "token", label: "봇 토큰", type: "password", autocomplete: "off" }],
    description:
      "Discord Developer Portal → Bot에서 발급한 봇 토큰으로 연결해요. 봇을 서버에 초대하고 Message Content Intent를 켜 주세요.",
    capabilities: ["list", "read", "send", "search"],
  },
  telegram: {
    id: "telegram",
    name: "텔레그램",
    category: "messenger",
    icon: "telegram",
    hue: 200,
    // the relay seals a session (TDLib database key) as a token credential; nothing is typed into a form
    auth: "token",
    login: "phone_code",
    fields: [],
    description:
      "전화번호로 로그인해요. 텔레그램 앱으로 온 코드를 입력하고, 2단계 인증을 켰다면 그 비밀번호도 입력하면 돼요. 대화방을 읽고 허락받은 메시지를 보내요. 모시는 '모시'라는 기기로 로그인돼서 텔레그램 설정 → 기기에서 언제든 끊을 수 있어요.",
    capabilities: ["list", "read", "send"],
  },
  telegrambot: {
    id: "telegrambot",
    name: "텔레그램 봇",
    category: "messenger",
    icon: "telegram",
    hue: 205,
    auth: "token",
    login: "bot_token",
    advanced: true,
    fields: [{ key: "token", label: "봇 토큰", type: "password", autocomplete: "off", placeholder: "123456789:ABC…" }],
    description:
      "텔레그램에서 @BotFather에게 /newbot으로 봇을 만들고 받은 토큰을 붙여 넣어 주세요. 봇에게 최근(24시간 이내) 온 대화만 볼 수 있어요.",
    capabilities: ["list", "read", "send"],
  },
  line: {
    id: "line",
    name: "라인",
    category: "messenger",
    icon: "chat",
    hue: 140,
    auth: "credentials",
    login: "password",
    fields: [{ key: "email", label: "LINE 이메일", type: "email", autocomplete: "username" }, pw()],
    description:
      "LINE 계정 이메일로 로그인해요. 처음 연결할 땐 휴대폰 LINE 앱에서 화면에 보이는 PIN을 입력해 확인해야 해요. (LINE 설정 → 계정에서 이메일 로그인을 허용해 주세요)",
    capabilities: ["list", "read", "send", "search"],
  },
  instagram: {
    id: "instagram",
    name: "인스타그램",
    category: "messenger",
    icon: "chat",
    hue: 330,
    auth: "credentials",
    login: "password",
    fields: [
      { key: "username", label: "인스타그램 아이디", type: "text", autocomplete: "username", placeholder: "@없이 입력" },
      pw(),
    ],
    description:
      "인스타그램 DM을 읽고 보내요. 2단계 인증을 켠 계정은 인스타그램이 보낸 인증 코드를 한 번 입력하면 돼요. 인스타그램이 보안 확인을 요청하면 앱에서 먼저 확인해 주세요.",
    capabilities: ["list", "read", "send", "search"],
  },
  teams: {
    id: "teams",
    name: "Microsoft Teams",
    category: "messenger",
    icon: "chat",
    hue: 245,
    auth: "oauth",
    login: "device_code",
    fields: [],
    description:
      "회사 Microsoft 계정으로 Teams 채팅을 읽고 보내요. 연결을 누르면 나오는 코드를 microsoft.com/devicelogin에 입력하고 로그인하면 돼요. 비밀번호는 모시에 저장되지 않아요.",
    capabilities: ["list", "read", "send", "search"],
  },
  webex: {
    id: "webex",
    name: "Webex",
    category: "messenger",
    icon: "chat",
    hue: 190,
    auth: "credentials",
    login: "password",
    fields: [{ key: "email", label: "Webex 이메일", type: "email", autocomplete: "username" }, pw()],
    description: "Webex 이메일·비밀번호로 스페이스 메시지를 읽고 보내요. 회사 SSO로만 로그인하는 계정은 지원하지 않아요.",
    capabilities: ["list", "read", "send", "search"],
  },
};

// ───────────────────────────── availability ─────────────────────────────

const availability = new Map<ProviderId, { ok: boolean; reason?: string }>();
/** Telegram user login needs the operator's app registration (api_id/api_hash) on the server */
const TELEGRAM_NOT_READY = "준비 중이에요";
let probing: Promise<void> | null = null;

/** Synchronous best guess: can the SDK subpath be resolved at all? */
function resolvable(spec: string): boolean {
  try {
    import.meta.resolve(spec);
    return true;
  } catch {
    return false;
  }
}

/** Actually imports every SDK subpath once and caches the result for `providers()`. */
export function probeProviders(): Promise<void> {
  probing ??= (async () => {
    await Promise.all(
      PROVIDER_IDS.map(async (id) => {
        try {
          if (id === "telegram") {
            // env + files only: the native library loads with the first Telegram login, never at boot
            availability.set(id, telegramAppFromEnv() && tdjsonAvailable() ? { ok: true } : { ok: false, reason: TELEGRAM_NOT_READY });
            return;
          } else {
            await import(SDK_SUBPATH[id]);
          }
          availability.set(id, { ok: true });
        } catch {
          availability.set(id, { ok: false, reason: id === "telegram" ? TELEGRAM_NOT_READY : "서버에 메신저 연결 모듈(agent-messenger)이 설치되지 않았어요." });
        }
      }),
    );
  })();
  return probing;
}

export function providerInfo(id: ProviderId): ProviderInfo {
  const entry = CATALOG[id];
  let state = availability.get(id);
  if (!state && id === "telegram") state = telegramAppFromEnv() && tdjsonAvailable() ? { ok: true } : { ok: false, reason: TELEGRAM_NOT_READY };
  if (!state) {
    state = resolvable(SDK_SUBPATH[id])
      ? { ok: true }
      : { ok: false, reason: "서버에 메신저 연결 모듈(agent-messenger)이 설치되지 않았어요." };
  }
  return {
    ...entry,
    fields: entry.fields.map((f) => ({ ...f })),
    capabilities: [...entry.capabilities],
    available: state.ok,
    ...(state.ok ? {} : { unavailableReason: state.reason }),
  };
}

export function providers(): ProviderInfo[] {
  return PROVIDER_IDS.map(providerInfo);
}

/** Korean display name ("카카오톡") for a provider id; falls back to the id. */
export function providerName(id: string): string {
  return isProviderId(id) ? CATALOG[id].name : id;
}
