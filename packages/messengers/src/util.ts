import type { MessengerChat, MessengerMessageKind } from "@pickle/protocol";

export type MessageKind = MessengerMessageKind;

/**
 * The one normalised message every adapter returns (KakaoTalk, Slack, Discord, …). Ids here are the provider's own
 * (internal: reply/name resolution); cards and the LLM never see them (see thread.ts).
 */
export interface ChatMessage {
  id: string;
  at: number | null;
  /** provider user id ("" for system lines) */
  senderId: string;
  /** display name, open-chat profile tags stripped ("김도윤/남/68년생/사진" → "김도윤"); "" for system lines */
  senderName: string;
  /** the full nickname when it differs from senderName */
  senderFull?: string;
  isMe: boolean;
  kind: MessageKind;
  text: string;
  replyTo?: { senderName: string; text: string; isMe?: boolean };
  attachment?: { label: string };
  /** the message @-mentions the user */
  mentionsMe?: boolean;
}

/** What adapters hand to finishMessages: only text/at are required, the rest is filled in. */
export type RawMessage = Partial<Omit<ChatMessage, "text" | "at">> & { text: string; at: number | null; author?: string };

/** Room facts an adapter may know beyond MessengerChat (KakaoTalk: CHATINFO + member snapshot). */
export interface RoomInfo {
  /** the room's own title (user-set / open-chat name); absent for unnamed groups */
  title?: string;
  kind?: "dm" | "group" | "open" | "channel";
  /** members including the user */
  memberCount?: number;
  unread?: number;
  /** other members' raw nicknames, in the messenger's order (for unnamed-group titles) */
  memberNames?: string[];
  /** names the user goes by in this room (mention detection) */
  myNames?: string[];
}

export interface ThreadRead {
  room: RoomInfo;
  messages: ChatMessage[];
}

/** Numbers in s / ms / µs, numeric strings, or ISO strings → epoch ms. */
export function toMillis(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) n = Number(v);
  else if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  } else return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) return Math.round(n * 1000); // seconds
  if (n > 1e14) return Math.round(n / 1000); // microseconds
  return Math.round(n);
}

export function clip(s: string, max: number): string {
  const chars = Array.from(s ?? "");
  return chars.length <= max ? s ?? "" : `${chars.slice(0, max - 1).join("")}…`;
}

export function stripHtml(s: string): string {
  return (s ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export function matchesSearch(name: string, search: string | undefined): boolean {
  if (!search) return true;
  return name.toLocaleLowerCase("ko").includes(search.trim().replace(/^#/, "").toLocaleLowerCase("ko"));
}

/** filter by search, keep provider order, cap. */
export function finishChats(chats: MessengerChat[], search: string | undefined, limit: number): MessengerChat[] {
  return chats.filter((c) => matchesSearch(c.name, search)).slice(0, limit);
}

// ───────────────────────────── message normalisation ─────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;

/** "https://www.example.com/x" → "example.com" (null when there is no URL). */
export function linkHost(text: string): string | null {
  const m = URL_RE.exec(text ?? "");
  if (!m) return null;
  try {
    return new URL(m[0]).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** True for a body that is a serialised object/array (system payloads some providers put in `text`). */
export function looksLikeJson(text: string): boolean {
  const t = (text ?? "").trim();
  if (!(t.startsWith("{") && t.endsWith("}")) && !(t.startsWith("[") && t.endsWith("]"))) return false;
  if (/^\{\s*"[A-Za-z_]+"\s*:/.test(t)) return true;
  try {
    const v = JSON.parse(t);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

const GENDER = /^(남|여|남자|여자|男|女|M|F)$/i;
const AGE = /^(\d{2}|\d[0-9*]|\d{2}\*|\d{2,4}\s*년생|\d{2}년|\d0\s*대(\s*(초|중|후)반?)?|\d{2}\s*살|\d{2}\s*세)$/;
const isTag = (s: string) => GENDER.test(s.trim()) || AGE.test(s.trim());

/**
 * Open-chat nicknames often carry a profile tag suffix: "김도윤/남/68년생/사진", "초롱별/여/51/무용",
 * "민수(남/92)". Strip it only when it clearly is one (a gender or age segment right after the name); otherwise the
 * name is returned unchanged ("BTR-moka", "달빛 고양이", "Kim/Engineering").
 */
export function splitDisplayName(raw: string): { short: string; full?: string } {
  const full = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!full) return { short: "" };
  // "이름(남/92)" · "이름 [여, 51]"
  const paren = /^(.+?)\s*[([（]([^)\]）]+)[)\]）]\s*$/.exec(full);
  if (paren) {
    const parts = paren[2]!.split(/[/,·\s]+/).filter(Boolean);
    if (parts.length && parts.some(isTag)) return { short: paren[1]!.trim(), full };
  }
  for (const sep of ["/", "_", "|"]) {
    if (!full.includes(sep)) continue;
    const parts = full.split(sep).map((p) => p.trim());
    const head = parts[0]!;
    const rest = parts.slice(1).filter(Boolean);
    if (!head || !rest.length) continue;
    // "/" needs a gender or age right after the name; "_" and "|" are common in handles, so they need a gender
    const ok = sep === "/" ? isTag(rest[0]!) || (rest.length >= 2 && rest.slice(0, 2).some(isTag)) : rest.some((p) => GENDER.test(p));
    if (ok) return { short: head, full };
  }
  return { short: full };
}

/**
 * Fill in the model for a raw adapter message: ids, display name split, link detection, and a guard so a serialised
 * payload never reaches the user as text.
 */
export function toChatMessage(m: RawMessage, index: number): ChatMessage {
  const name = splitDisplayName(m.senderName ?? m.author ?? "");
  const kind: MessageKind = m.kind ?? "text";
  let text = (m.text ?? "").replace(/\r\n?/g, "\n");
  let out: ChatMessage = {
    id: m.id || `m${index}`,
    at: m.at,
    senderId: m.senderId ?? (name.full ?? name.short),
    senderName: m.isMe ? "나" : name.short || (kind === "system" ? "" : "알 수 없음"),
    isMe: m.isMe ?? false,
    kind,
    text,
  };
  if (name.full && !m.isMe) out.senderFull = name.full;
  if (m.replyTo) out.replyTo = m.replyTo;
  if (m.attachment) out.attachment = m.attachment;
  if (m.mentionsMe) out.mentionsMe = true;
  if (looksLikeJson(text)) {
    text = "";
    out = { ...out, kind: kind === "text" ? "other" : kind, text, attachment: out.attachment ?? { label: "메시지" } };
  }
  if (out.kind === "text") {
    const host = linkHost(text);
    if (host) out = { ...out, kind: "link", attachment: out.attachment ?? { label: host } };
  }
  return out;
}

/** oldest → newest, newest `limit` kept, normalised. */
export function finishMessages(msgs: RawMessage[], limit: number): ChatMessage[] {
  const sorted = msgs.map((m, i) => ({ m, i })).sort((a, b) => (a.m.at ?? 0) - (b.m.at ?? 0) || a.i - b.i);
  return sorted.slice(Math.max(0, sorted.length - limit)).map(({ m, i }) => toChatMessage(m, i));
}

/** A promise plus its resolve/reject handles. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ───────────────────────────── AGENT_MESSENGER_CONFIG_DIR ─────────────────────────────

export const CONFIG_DIR_ENV = "AGENT_MESSENGER_CONFIG_DIR";
let envChain: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` with `AGENT_MESSENGER_CONFIG_DIR=<dir>` (process-wide!), serialised so two users'
 * calls never overlap. Only for SDK code paths that resolve the config dir lazily from the env
 * instead of taking it as a parameter (LINE's E2EE key store). Everything else gets its
 * per-user dir passed explicitly.
 */
export function withConfigDirEnv<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const prev = process.env[CONFIG_DIR_ENV];
    process.env[CONFIG_DIR_ENV] = dir;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env[CONFIG_DIR_ENV];
      else process.env[CONFIG_DIR_ENV] = prev;
    }
  };
  const p = envChain.then(run, run);
  envChain = p.catch(() => {});
  return p;
}
