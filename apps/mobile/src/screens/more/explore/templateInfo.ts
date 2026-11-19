import type { Connection, ProviderInfo, SkillInfo, TaskTemplate } from "@pickle/protocol";
import { hasBrandIcon } from "../../../assets/brands/BrandIcon";
import type { AppIconName } from "../../../ui/Icon";

/**
 * What a template will do, in plain Korean, for the pre-delegation sheet (MOTION-SPEC §8.9, research §3-7): the
 * steps and their sources, required connections, a rough time and quota estimate, and where the result lands.
 * Estimates are labelled as such ("약") — they are not promises.
 */

export interface Step {
  id: string;
  icon: AppIconName;
  title: string;
  source?: string;
}

/** tools that are not k-skills (no SkillInfo): noun labels */
const SYSTEM: Record<string, { title: string; icon: AppIconName; source?: string }> = {
  sys_schedule_create: { title: "예약 만들기", icon: "clock", source: "예약된 일" },
  sys_schedule_list: { title: "예약 확인", icon: "clock", source: "예약된 일" },
  sys_show_briefing: { title: "브리핑 카드 정리", icon: "doc" },
  sys_create_artifact: { title: "문서 만들기", icon: "doc", source: "보관함" },
  sys_friend_message: { title: "친구의 모시에게 말 전하기", icon: "people", source: "친구" },
  sys_friends_list: { title: "친구 목록 보기", icon: "people", source: "친구" },
  sys_phone_call: { title: "전화 걸기", icon: "phone", source: "승인 후" },
  sys_remember: { title: "기억하기", icon: "archive" },
  sys_web_fetch: { title: "웹 페이지 읽기", icon: "globe" },
  msg_list_chats: { title: "대화방 목록 보기", icon: "chat" },
  msg_read: { title: "메시지 읽기", icon: "chat" },
  msg_send: { title: "허락받은 메시지 보내기", icon: "send" },
};

/** template → messenger providers it needs (any one of them connected is enough) */
const NEEDS_BY_ICON: Record<string, string[]> = {
  kakao: ["kakaotalk"],
  slack: ["slack", "slackbot"],
  discord: ["discord", "discordbot"],
  telegram: ["telegrambot"],
};
const NEEDS_BY_TEXT: [RegExp, string[]][] = [
  [/카카오|kakao/i, ["kakaotalk"]],
  [/슬랙|slack/i, ["slack", "slackbot"]],
  [/디스코드|discord/i, ["discord", "discordbot"]],
  [/텔레그램|telegram/i, ["telegrambot"]],
  [/라인|\bline\b/i, ["line"]],
  [/인스타|instagram/i, ["instagram"]],
];

/**
 * The real service a template is about, for its app icon (assets/brands), or null (the row keeps its bare glyph):
 * by the template's icon first ("kakao", "slack"), then, for a messenger template, by the service its words name.
 * A service without an official mark in assets/brands (the phone app, Google Meet …) also stays a glyph.
 */
export function brandFor(tpl: TaskTemplate): string | null {
  if (hasBrandIcon(tpl.icon)) return tpl.icon;
  if (!tpl.skills.some((s) => s.startsWith("msg_"))) return null;
  const ids = NEEDS_BY_TEXT.find(([re]) => re.test(tpl.title + tpl.description))?.[1] ?? [];
  return ids.find((id) => hasBrandIcon(id)) ?? null;
}

export function stepsFor(tpl: TaskTemplate, skills: SkillInfo[], providerName?: string): Step[] {
  const byId = new Map(skills.map((s) => [s.id, s]));
  if (tpl.id === "call-demo") return [{ id: "sys_phone_call", icon: "phone", title: "내 휴대폰으로 전화 걸기", source: "걸기 전에 한 번 더 승인받아요" }];
  return tpl.skills.map((id) => {
    const k = byId.get(id);
    if (k) return { id, icon: k.icon as AppIconName, title: k.title, source: sourceOf(k) };
    const s = SYSTEM[id];
    if (s) return { id, icon: s.icon, title: s.title, source: id.startsWith("msg_") ? providerName : s.source };
    return { id, icon: "bolt", title: "작업하기" };
  });
}

/** "NomaDamas/k-skill · korea-weather" is not for people; the description names the real source ("기상청 …") */
function sourceOf(k: SkillInfo): string | undefined {
  const m = k.description.match(/^([^\s,·]+?)(?:에서|의|로|으로)?\s/);
  const head = m?.[1];
  if (head && head.length <= 12 && !/^(지금|올해|이번|수도권|서울|근처)/.test(head)) return head.replace(/(에서|의)$/, "");
  return undefined;
}

export interface Need {
  kind: "messenger" | "friend";
  providers: string[];
  /** the provider this row is named after (its app icon), when it is one */
  brand?: string;
  name: string;
  icon: AppIconName;
  hue: number;
  connected: boolean;
}

export function needsFor(tpl: TaskTemplate, providers: ProviderInfo[], connections: Connection[], friendCount: number): Need[] {
  const out: Need[] = [];
  if (tpl.skills.some((s) => s.startsWith("msg_"))) {
    const ids = NEEDS_BY_ICON[tpl.icon] ?? NEEDS_BY_TEXT.find(([re]) => re.test(tpl.title + tpl.description))?.[1] ?? [];
    const first = providers.find((p) => ids.includes(p.id));
    if (ids.length) {
      out.push({
        kind: "messenger",
        providers: ids,
        brand: first?.id ?? ids[0],
        name: first?.name ?? ids[0]!,
        icon: (first?.icon as AppIconName) ?? "chat",
        hue: first?.hue ?? 210,
        connected: connections.some((c) => ids.includes(c.provider) && c.status === "connected"),
      });
    }
  }
  if (tpl.skills.includes("sys_friend_message")) {
    out.push({ kind: "friend", providers: [], name: "친구", icon: "people", hue: 345, connected: friendCount > 0 });
  }
  return out;
}

const EXTERNAL = (id: string) => id.startsWith("k_") || id.startsWith("msg_") || id === "sys_web_fetch";

/** rough tokens for one delegated turn: a base answer plus each outside lookup and a written document */
export function estimateTokens(tpl: TaskTemplate): number {
  const ext = tpl.skills.filter(EXTERNAL).length;
  return 6000 + 4000 * ext + (tpl.skills.includes("sys_create_artifact") ? 6000 : 0) + (tpl.skills.includes("sys_show_briefing") ? 3000 : 0);
}

/** rough wall time in seconds */
export function estimateSeconds(tpl: TaskTemplate): number {
  if (tpl.id === "call-demo") return 60;
  const ext = tpl.skills.filter(EXTERNAL).length;
  return 10 + 8 * ext + (tpl.skills.includes("sys_create_artifact") ? 20 : 0);
}

export function secondsKo(s: number): string {
  if (s < 50) return `약 ${Math.max(10, Math.round(s / 10) * 10)}초`;
  if (s < 90) return "약 1분";
  return `약 ${Math.round(s / 60)}분`;
}

export function resultFor(tpl: TaskTemplate): { icon: AppIconName; text: string } {
  if (tpl.id === "call-demo") return { icon: "phone", text: "승인하면 바로 전화가 와요. 통화 내용은 이 대화에 남아요." };
  if (tpl.skills.includes("sys_create_artifact")) return { icon: "doc", text: "다 만들면 보관함에 문서로 저장돼요." };
  if (tpl.skills.includes("sys_schedule_create")) return { icon: "clock", text: "예약된 일에 추가돼요. 언제든 끄거나 지울 수 있어요." };
  if (tpl.skills.includes("sys_show_briefing")) return { icon: "doc", text: "브리핑 카드로 한눈에 보여 드려요." };
  if (tpl.skills.includes("sys_friend_message")) return { icon: "people", text: "친구의 모시에게 전하고, 답이 오면 알려 드려요." };
  return { icon: "chat", text: "새 대화에서 정리해 드려요." };
}

/** prompts that say "모르면 먼저 물어봐" start with a question */
export const asksFirst = (tpl: TaskTemplate) => /물어/.test(tpl.prompt);
