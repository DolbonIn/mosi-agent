import type { IconName } from "@pickle/protocol";

/** Runtime list of protocol IconNames (the compile-time check below fails if the protocol adds one). */
export const ICON_NAMES = [
  "chat", "compass", "archive", "person", "people", "search", "plus", "mic", "phone", "phone-out",
  "calendar", "cloud", "sun", "moon", "checkmark", "chevron-right", "chevron-left", "close", "menu",
  "shield", "lock", "key", "card", "bell", "paintbrush", "star", "coins", "bag", "plane",
  "film", "house", "sparkles", "doc", "chart", "photo", "link", "send", "paperclip", "trash",
  "clock", "bolt", "gift", "map", "train", "bus", "won", "heart", "slack", "kakao", "discord",
  "telegram", "mail", "ellipsis", "eye", "wave", "stop", "play", "pause", "speaker", "magnifier",
] as const satisfies readonly IconName[];

type MissingIcon = Exclude<IconName, (typeof ICON_NAMES)[number]>;
const _iconsComplete: [MissingIcon] extends [never] ? true : MissingIcon = true;
void _iconsComplete;

const ICON_SET: ReadonlySet<string> = new Set(ICON_NAMES);

export function isIconName(v: unknown): v is IconName {
  return typeof v === "string" && ICON_SET.has(v);
}

export function iconOr(v: unknown, fallback: IconName = "sparkles"): IconName {
  return isIconName(v) ? v : fallback;
}
