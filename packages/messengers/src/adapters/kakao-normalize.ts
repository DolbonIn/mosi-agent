/**
 * KakaoTalk chat logs → the shared ChatMessage model. Pure (no I/O, no logging).
 *
 * LOCO message types (agent-messenger@2.43.0 `KAKAO_MESSAGE_TYPE` + `KAKAO_EMOTICON_KIND_BY_TYPE`, and the
 * storycraft/node-kakao `KnownChatType` table for the rest):
 *   0 feed (system) · 1 text · 2 photo · 3 video · 4 contact · 5 audio · 6 emoticon (ditem) · 7 gift · 9 kakaolink
 *   11 avatar · 12 sticker · 13 schedule · 14 vote · 15 lottery · 16 location · 17 profile · 18 file · 20 animated
 *   sticker · 21 nudge · 22 actioncon · 23 search · 24 post · 25 gif sticker · 26 reply · 27 multi-photo · 51 voip
 *   71 custom (link card) · 72 alim · 81–83 plus friend · 96 open schedule · 97 open vote · 98 open post.
 *   type + 16384 = the same message deleted by its sender.
 *
 * Feeds (type 0) carry a JSON body `{"feedType":N,…}` (node-kakao `KnownFeedType`): 1 invite, 2 leave, 3 secret
 * leave, 4 open-chat join, 6 open-chat kick, 7 kick, 11/12 manager grant/revoke, 13 host hid messages (rewrite),
 * 14 deleted for everyone, 15 host handed over. Newer clients also send 25 (a host hiding a message, with
 * `logId`). A feed with `"hidden":true` is never shown, and messages a moderation feed (13/14/25) points at are
 * dropped too. Unknown feeds are dropped — raw JSON never reaches the user.
 */
import type { KakaoMessage } from "agent-messenger/kakaotalk";
import { clip, splitDisplayName, toChatMessage, toMillis, type ChatMessage, type RawMessage } from "../util";

export const KAKAO_DELETED_FLAG = 16384;

const EMOTICON_TYPES = new Set([6, 12, 20, 22, 25]);
const MODERATION_FEEDS = new Set([13, 14, 25]);

export interface KakaoNormalizeCtx {
  /** the logged-in user's id (exact decimal) */
  myUserId: string | null;
  /** user id (exact decimal) → nickname as the room shows it */
  names: Map<string, string>;
}

// ───────────────────────────── ids ─────────────────────────────

/**
 * Every id shape KakaoTalk data arrives in → exact decimal string: decimal strings, safe numbers, bigint, BSON Long
 * / `{low, high}` (open-chat author ids). Unsafe numbers keep whatever digits they still have.
 */
export function exactId(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isSafeInteger(v) ? String(v) : BigInt(Math.round(v)).toString()) : "";
  if (typeof v === "object") {
    const o = v as { low?: unknown; high?: unknown; unsigned?: unknown; digits?: unknown };
    if (typeof o.digits === "string") return o.digits;
    if (Number.isInteger(o.low) && Number.isInteger(o.high)) {
      const bits = (BigInt((o.high as number) >>> 0) << 32n) | BigInt((o.low as number) >>> 0);
      return (o.unsigned ? bits : BigInt.asIntN(64, bits)).toString();
    }
  }
  return "";
}

/**
 * JSON.parse that keeps integers beyond 2^53 exact (as decimal strings) — log ids and open-chat user ids inside feed
 * bodies are ~19 digits. Strings are copied untouched.
 */
export function parseExactJson(raw: string): unknown {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      out += raw.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + 1;
      while (j < raw.length && /[0-9.eE+-]/.test(raw[j]!)) j++;
      const tok = raw.slice(i, j);
      out += /^-?\d+$/.test(tok) && !Number.isSafeInteger(Number(tok)) ? `"${tok}"` : tok;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out);
}

// ───────────────────────────── feeds ─────────────────────────────

interface FeedMember {
  userId?: unknown;
  nickName?: unknown;
  nickname?: unknown;
}
export interface KakaoFeed {
  feedType: number;
  hidden?: boolean;
  logId?: unknown;
  logIds?: unknown[];
  member?: FeedMember;
  members?: FeedMember[];
  inviter?: FeedMember;
  prevHost?: FeedMember;
  newHost?: FeedMember;
  kicked?: boolean;
}

export function parseFeed(body: string): KakaoFeed | null {
  if (typeof body !== "string" || !body.trim().startsWith("{")) return null;
  try {
    const v = parseExactJson(body) as Record<string, unknown>;
    if (!v || typeof v !== "object" || typeof v.feedType !== "number") return null;
    return v as unknown as KakaoFeed;
  } catch {
    return null;
  }
}

function feedTargets(f: KakaoFeed): string[] {
  const out: string[] = [];
  if (f.logId !== undefined) out.push(exactId(f.logId));
  if (Array.isArray(f.logIds)) for (const id of f.logIds) out.push(exactId(id));
  return out.filter(Boolean);
}

function memberName(m: FeedMember | undefined, ctx: KakaoNormalizeCtx): string {
  if (!m) return "";
  const id = exactId(m.userId);
  if (id && ctx.myUserId && id === ctx.myUserId) return "나";
  const raw = (typeof m.nickName === "string" && m.nickName) || (typeof m.nickname === "string" && m.nickname) || (id ? ctx.names.get(id) : "") || "";
  return splitDisplayName(raw).short;
}

/** "김도윤님", "김도윤님, 해피님" — "나" stays "내가"-free: the subject form is handled by the caller. */
function people(ms: (FeedMember | undefined)[], ctx: KakaoNormalizeCtx): string {
  const names = ms.map((m) => memberName(m, ctx)).filter(Boolean);
  if (!names.length) return "";
  const shown = names.slice(0, 3).map((n) => (n === "나" ? "나" : `${n}님`));
  return names.length > 3 ? `${shown.join(", ")} 외 ${names.length - 3}명` : shown.join(", ");
}

/** A short Korean system line for a feed, or null when the feed is not shown. */
export function feedLine(f: KakaoFeed, ctx: KakaoNormalizeCtx): string | null {
  if (f.hidden === true) return null;
  const list = f.members?.length ? f.members : f.member ? [f.member] : [];
  const who = people(list, ctx);
  const subj = (s: string) => (s === "나" ? "내가" : `${s}이`); // "김도윤님이" · "내가"
  switch (f.feedType) {
    case 1: {
      const by = people([f.inviter], ctx);
      if (!who) return null;
      return by ? `${subj(by)} ${who === "나" ? "나를" : `${who}을`} 초대했어요` : `${who}이 초대됐어요`;
    }
    case 2:
    case 3:
      if (!who) return null;
      return f.kicked ? `${who === "나" ? "나를" : `${who}을`} 내보냈어요` : `${subj(who)} 나갔어요`;
    case 4:
      return who ? `${subj(who)} 들어왔어요` : null;
    case 6:
    case 7:
      return who ? `${who === "나" ? "나를" : `${who}을`} 내보냈어요` : null;
    case 11:
      return who ? `${subj(who)} 부방장이 됐어요` : null;
    case 12:
      return who ? `${who}의 부방장 권한이 해제됐어요` : null;
    case 15: {
      const host = people([f.newHost ?? list[list.length - 1]], ctx);
      return host ? `${subj(host)} 방장이 됐어요` : null;
    }
    default:
      return null; // 13/14/25 (moderation) and anything unknown: never shown
  }
}

// ───────────────────────────── messages ─────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function attachmentLabel(type: number, a: Record<string, unknown> | null, text: string): Pick<RawMessage, "kind" | "attachment" | "text"> {
  const att = a ?? {};
  switch (type) {
    case 2:
      return { kind: "photo", text: "", attachment: { label: "사진" } };
    case 27: {
      const n = Array.isArray(att.kl) ? att.kl.length : Array.isArray(att.imageUrls) ? att.imageUrls.length : 0;
      return { kind: "photo", text: "", attachment: { label: n > 1 ? `사진 ${n}장` : "사진" } };
    }
    case 3:
      return { kind: "video", text: "", attachment: { label: "동영상" } };
    case 5:
      return { kind: "other", text: "", attachment: { label: "음성 메시지" } };
    case 18: {
      const name = str(att.name);
      return { kind: "file", text: "", attachment: { label: name ? `파일 · ${clip(name, 60)}` : "파일" } };
    }
    case 4:
      return { kind: "other", text: "", attachment: { label: "연락처" } };
    case 7:
      return { kind: "other", text: "", attachment: { label: "선물" } };
    case 13:
    case 96: {
      const title = str(att.title) || str(att.subject);
      return { kind: "other", text: "", attachment: { label: title ? `일정 · ${clip(title, 40)}` : "일정" } };
    }
    case 14:
    case 97: {
      const title = str(att.title) || str(att.subject) || str((att.os as Record<string, unknown> | undefined)?.title);
      return { kind: "other", text: "", attachment: { label: title ? `투표 · ${clip(title, 40)}` : "투표" } };
    }
    case 16: {
      const place = str(att.n) || str(att.name) || str(att.a);
      return { kind: "other", text: "", attachment: { label: place ? `지도 · ${clip(place, 40)}` : "지도" } };
    }
    case 17:
      return { kind: "other", text: "", attachment: { label: "프로필" } };
    case 21:
      return { kind: "other", text: "", attachment: { label: "콕 찌르기" } };
    case 51:
      return { kind: "other", text: "", attachment: { label: "통화" } };
    case 9:
    case 23:
    case 24:
    case 71:
    case 98: {
      const title = text || str(att.title) || str((att.P as Record<string, unknown> | undefined)?.TI) || str(att.text);
      return { kind: "link", text: title, attachment: { label: type === 24 || type === 98 ? "게시글" : "링크" } };
    }
    default:
      // alim / plus-friend / anything newer: its text if it has plain text (the JSON guard in toChatMessage still applies)
      return text ? { kind: "text", text } : { kind: "other", text: "", attachment: { label: "메시지" } };
  }
}

function senderOf(id: string, fallback: string | null, ctx: KakaoNormalizeCtx): { senderName: string; isMe: boolean } {
  if (ctx.myUserId && id === ctx.myUserId) return { senderName: "나", isMe: true };
  return { senderName: ctx.names.get(id) || fallback || "", isMe: false };
}

/** One chat log → a RawMessage, or null when it must not be shown (hidden/unknown feeds). */
function convert(m: KakaoMessage, ctx: KakaoNormalizeCtx): RawMessage | null {
  const id = exactId(m.log_id);
  const at = toMillis(m.sent_at);
  const rawType = typeof m.type === "number" ? m.type : Number(m.type) || 0;
  const deleted = rawType >= KAKAO_DELETED_FLAG;
  const type = deleted ? rawType % KAKAO_DELETED_FLAG : rawType;
  const text = typeof m.message === "string" ? m.message : "";
  const authorId = exactId(m.author_id as unknown);

  if (type === 0) {
    const f = parseFeed(text);
    const line = f ? feedLine(f, ctx) : null;
    return line ? { id, at, senderId: "", senderName: "", kind: "system", text: line } : null;
  }

  const who = senderOf(authorId, m.author_name, ctx);
  const mentionsMe = !!ctx.myUserId && (m.mentions ?? []).some((x) => exactId(x.user_id) === ctx.myUserId);
  const base: RawMessage = { id, at, senderId: authorId, ...who, text: "", ...(mentionsMe ? { mentionsMe } : {}) };

  if (deleted) return { ...base, kind: "other", text: "", attachment: { label: "삭제된 메시지" } };
  if (type === 1) return { ...base, kind: "text", text };
  if (EMOTICON_TYPES.has(type)) {
    const t = text.trim() && text.trim() !== "이모티콘" ? text : "";
    return { ...base, kind: "emoticon", text: t, attachment: { label: "이모티콘" } };
  }
  if (type === 26) {
    const a = m.attachment ?? {};
    const srcId = exactId(a.src_userId);
    const srcType = typeof a.src_type === "number" ? a.src_type : 1;
    const srcText = str(a.src_message);
    const quoted = srcType === 1 || srcType === 26 ? srcText : attachmentLabel(srcType, null, "").attachment?.label ?? srcText;
    const src = srcId ? senderOf(srcId, null, ctx) : { senderName: "", isMe: false };
    const srcName = src.isMe ? "나" : splitDisplayName(src.senderName).short || "알 수 없음";
    return {
      ...base,
      kind: "reply",
      text,
      replyTo: { senderName: srcName, text: clip((quoted || "메시지").replace(/\s+/g, " "), 120), ...(src.isMe ? { isMe: true } : {}) },
    };
  }
  return { ...base, ...attachmentLabel(type, m.attachment, text.trim()) };
}

/**
 * Normalise a read: oldest → newest, newest `limit` kept, hidden feeds and the messages moderation feeds point at
 * dropped, every sender named from `ctx.names` (never a raw id).
 */
export function normalizeKakao(raw: KakaoMessage[], ctx: KakaoNormalizeCtx, limit = raw.length): ChatMessage[] {
  const sorted = [...raw].sort((a, b) => (toMillis(a.sent_at) ?? 0) - (toMillis(b.sent_at) ?? 0));
  const dropped = new Set<string>();
  for (const m of sorted) {
    const t = typeof m.type === "number" ? m.type % KAKAO_DELETED_FLAG : 0;
    if (t !== 0) continue;
    const f = parseFeed(m.message);
    if (f && MODERATION_FEEDS.has(f.feedType)) for (const id of feedTargets(f)) dropped.add(id);
  }
  const out: ChatMessage[] = [];
  for (const m of sorted) {
    if (dropped.has(exactId(m.log_id))) continue;
    const r = convert(m, ctx);
    if (r) out.push(toChatMessage(r, out.length));
  }
  return out.slice(Math.max(0, out.length - limit));
}

/** Author ids in a read that the name map does not cover (to resolve with one MEMBER lookup). */
export function unknownAuthorIds(raw: KakaoMessage[], ctx: KakaoNormalizeCtx): string[] {
  const out = new Set<string>();
  for (const m of raw) {
    const id = exactId(m.author_id as unknown);
    if (id && id !== ctx.myUserId && !ctx.names.has(id)) out.add(id);
    if (m.type === 26) {
      const src = exactId(m.attachment?.src_userId);
      if (src && src !== ctx.myUserId && !ctx.names.has(src)) out.add(src);
    }
  }
  return [...out];
}
