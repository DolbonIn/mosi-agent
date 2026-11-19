/**
 * A read chat as the user should see it: the room title, a compact transcript for the LLM, the 1–3 messages that
 * matter (collapsed card) and the card thread (expanded card). Pure functions — no I/O, no logging.
 *
 * Privacy: provider ids never leave this module. The card gets opaque per-card keys (m1…, p1…), the LLM gets
 * "[19:30] 김도윤: …" lines.
 */
import type { MessengerMessage, MessengerRoom } from "@pickle/protocol";
import { clip, splitDisplayName, type ChatMessage, type RoomInfo } from "./util";

const KST = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

// ───────────────────────────── room title ─────────────────────────────

/**
 * Title for a room without its own name: the other members' short names, most recent speakers first.
 *   ["김도윤", "초롱별", "해피", "BTR-moka", "달빛 고양이"] (6 members) → "김도윤, 초롱별 외 3명"
 *   ≤ 3 others → all of them ("민지, 준호"); a DM → the other person's name.
 */
export function buildRoomTitle(names: string[], opts: { memberCount?: number; kind?: RoomInfo["kind"] } = {}): string {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of names) {
    const n = splitDisplayName(raw).short;
    if (n && !seen.has(n)) {
      seen.add(n);
      list.push(n);
    }
  }
  if (!list.length) return "이름 없는 대화방";
  if (opts.kind === "dm") return list[0]!;
  const others = Math.max(list.length, opts.memberCount ? opts.memberCount - 1 : 0);
  if (others <= 3 && list.length >= others) return list.join(", ");
  const shown = list.slice(0, 2);
  return `${shown.join(", ")} 외 ${others - shown.length}명`;
}

const isDeleted = (m: ChatMessage) => m.kind === "other" && m.attachment?.label === "삭제된 메시지";

/** Member names ordered for a title: latest speakers in this read first, then the messenger's own order. */
export function titleNames(messages: ChatMessage[], memberNames: string[] = []): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.isMe || m.kind === "system" || isDeleted(m) || !m.senderName || m.senderName === "알 수 없음") continue;
    const full = m.senderFull ?? m.senderName;
    if (!out.includes(full)) out.push(full);
  }
  for (const n of memberNames) if (n && !out.includes(n)) out.push(n);
  return out;
}

export interface RoomInput {
  /** what the chat list calls it (MessengerChat.name) */
  listName: string;
  listKind: "dm" | "group" | "channel";
  unread?: number;
  info: RoomInfo;
}

/**
 * The room shown on the card. A room's own title wins; an unnamed group gets "A, B 외 N명" and keeps the full
 * member list (with profile tags) as `fullTitle` for the expanded view.
 */
export function roomOf(input: RoomInput, messages: ChatMessage[]): MessengerRoom {
  const { info } = input;
  const kind = info.kind ?? input.listKind;
  const unread = info.unread ?? input.unread;
  const base: Omit<MessengerRoom, "title"> = { kind, ...(info.memberCount ? { memberCount: info.memberCount } : {}), ...(unread ? { unread } : {}) };
  const own = info.title?.trim();
  if (own) return { title: clip(own, 60), ...base };
  if (kind === "channel") return { title: clip(input.listName, 60), ...base };
  // unnamed: the list name is usually the joined nicknames ("달빛 고양이, 해피/남/5*/뮤지컬, …")
  const members = info.memberNames?.length ? info.memberNames : input.listName.split(/,\s*/).filter(Boolean);
  const title = buildRoomTitle(titleNames(messages, members), { memberCount: info.memberCount, kind });
  const fullTitle = members.join(", ");
  return { title, ...(fullTitle && fullTitle !== title ? { fullTitle: clip(fullTitle, 300) } : {}), ...base };
}

// ───────────────────────────── highlights ─────────────────────────────

const LAUGH_ONLY = /^[\sㅋㅎㅠㅜ~!?.^;,ㄷㄱㅇ]+$/;
const REACTION_ONLY = /^(ㅇㅇ|ㅇㅋ|넵|네|넹|예|응|웅|오케이|ok|okay|굿|good|헐|와|대박|감사합니다|감사해요|고마워요?|ㄱㅅ|ㄳ|수고하셨습니다|수고하세요)[\s.!~^]*$/i;
const QUESTION = /[?？]|(까요|나요|가요|래요|할래|볼래|줄래|어때|어떠세요|어떠신가요|어떨까|될까|되나요|되세요|있나요|있으세요|계신가요|하시나요|인가요|맞나요|아세요)\s*[.!~]*$/;
const REQUEST = /(해\s?주세요|해\s?줘|해\s?주실|주실\s?수|줄\s?수|부탁|알려\s?주|확인\s?(해|부탁|좀)|보내\s?주|답\s?(장|변)\s?(좀|주)|참석\s?(여부|가능)|회신|가능하신|가능할까|가능한가요|투표\s?해|입금\s?(해|부탁|바랍))/;
const DATE = /(\d{1,2}\s?월\s?\d{1,2}\s?일|\d{1,2}[./]\d{1,2}(?![\d.]*\d{3})|오늘|내일|모레|글피|이번\s?주|다음\s?주|담주|주말|[월화수목금토일]요일|\d{1,2}\s?일\s?(에|까지|부터))/;
const TIME = /(\d{1,2}\s?시(\s?\d{1,2}\s?분|\s?반)?|\d{1,2}:\d{2}|오전|오후|아침|점심|저녁|새벽|밤\s?\d)/;
const PLACE = /(역에서|역\s?\d+번|출구|카페|식당|센터|회관|공연장|극장|강당|학교|사무실|주소|위치|장소|[실관장원점홀]에서|에서\s?(만나|봬|뵈|모여|모임|해요|합니다|진행)|로\s?(오세요|와|모여))/;
const MONEY = /(\d[\d,]*\s?(원|만\s?원|천\s?원)|₩\s?\d|회비|입금|계좌|송금|정산|티켓|예매|결제|환불|\d+\s?만\b)/;
const LINK = /https?:\/\//i;

export interface HighlightOptions {
  /** names the user goes by (account nickname, room nickname, 모시 display name) */
  myNames?: string[];
  /** keywords from the user's request ("공연 날짜 회비") — strongly boosted */
  focus?: string[];
  max?: number;
}

/** Keywords from a free-text focus: words ≥ 2 chars, particles trimmed, ≤ 8. */
export function focusTerms(focus: unknown): string[] {
  const raw = Array.isArray(focus) ? focus.join(" ") : typeof focus === "string" ? focus : "";
  const out: string[] = [];
  for (let w of raw.split(/[\s,·/|]+/)) {
    w = w.replace(/^["'“‘(]+|["'”’)?.!]+$/g, "").replace(/(은|는|이|가|을|를|에|에서|의|도|만|이랑|랑|하고|와|과|좀|요)$/u, "");
    if (Array.from(w).length >= 2 && !out.includes(w)) out.push(w);
  }
  return out.slice(0, 8);
}

/** Whether a message has content worth surfacing (not a system line, emoticon-only, laugh or bare reaction). */
export function isSubstantive(m: ChatMessage): boolean {
  if (m.kind === "system" || (m.kind === "emoticon" && !m.text.trim())) return false;
  const t = m.text.trim();
  if (!t) return m.kind === "file" || m.kind === "link";
  if (LAUGH_ONLY.test(t) || REACTION_ONLY.test(t)) return false;
  return true;
}

function nameHit(text: string, names: string[]): boolean {
  return names.some((n) => n.length >= 2 && text.includes(n));
}

/**
 * Score every substantive message and return the ids of the best 1–3, oldest → newest.
 *   +6 asks/requests something of the user (a question or request that mentions them or replies to them)
 *   +5 per focus keyword hit · +4 mentions the user (@-mention or their name)
 *   +3 a question / request to the room · +2 each for a date, time, place, money, link
 *   +0–2.5 recency · +1 substantial length (≥ 25 chars) · −2 very short · −1.5 the user's own message
 * A message only makes the cut with a positive score; if none does, the latest substantive message is used.
 */
export function pickHighlights(messages: ChatMessage[], opts: HighlightOptions = {}): string[] {
  const max = Math.max(1, Math.min(3, opts.max ?? 3));
  const names = (opts.myNames ?? []).map((n) => splitDisplayName(n).short).filter((n) => n.length >= 2);
  const focus = (opts.focus ?? []).map((f) => f.toLocaleLowerCase("ko"));
  const pool = messages.map((m, i) => ({ m, i })).filter(({ m }) => isSubstantive(m));
  if (!pool.length) return [];
  const n = messages.length;
  const scored = pool.map(({ m, i }) => {
    const t = `${m.text} ${m.attachment?.label ?? ""}`;
    const lower = t.toLocaleLowerCase("ko");
    let s = 0;
    const toMe = !m.isMe && (m.mentionsMe || nameHit(t, names) || m.replyTo?.isMe === true);
    const ask = !m.isMe && (QUESTION.test(m.text.trim()) || REQUEST.test(m.text));
    if (ask && toMe) s += 6;
    else if (ask) s += 3;
    if (toMe) s += 4;
    for (const f of focus) if (f && lower.includes(f)) s += 5;
    for (const re of [DATE, TIME, PLACE, MONEY, LINK]) if (re.test(t)) s += 2;
    s += 2.5 * ((i + 1) / n);
    const len = Array.from(m.text.trim()).length;
    if (len >= 25) s += 1;
    if (len > 0 && len < 4) s -= 2;
    if (m.isMe) s -= 1.5;
    return { id: m.id, i, s };
  });
  const best = scored
    .filter((x) => x.s > 2.6) // more than recency alone
    .sort((a, b) => b.s - a.s || b.i - a.i)
    .slice(0, max);
  if (!best.length) {
    const last = scored[scored.length - 1]!;
    return [last.id];
  }
  return best.sort((a, b) => a.i - b.i).map((x) => x.id);
}

// ───────────────────────────── LLM transcript ─────────────────────────────

/** "사진" · "파일 · 견적서.pdf" · "이모티콘" … (what a non-text message is, in a few words). */
export function placeholder(m: ChatMessage): string {
  if (m.attachment?.label) return m.attachment.label;
  switch (m.kind) {
    case "photo":
      return "사진";
    case "video":
      return "동영상";
    case "file":
      return "파일";
    case "emoticon":
      return "이모티콘";
    default:
      return "메시지";
  }
}

function lineText(m: ChatMessage, max: number): string {
  const body = m.text.trim().replace(/\s*\n\s*/g, " / ");
  const media = m.kind === "photo" || m.kind === "video" || m.kind === "file" || m.kind === "emoticon" || (m.kind === "other" && m.attachment);
  const parts: string[] = [];
  if (m.replyTo) parts.push(`(${m.replyTo.senderName}의 "${clip(m.replyTo.text.replace(/\s+/g, " "), 30)}"에 답장)`);
  if (media) parts.push(`(${placeholder(m)})`);
  if (body) parts.push(body);
  return clip(parts.join(" "), max);
}

/** "[19:30]" — with the date when the read spans several days ("[11/12 19:30]"). */
function stamp(at: number | null, withDate: boolean): string {
  if (!at) return "";
  const d = new Date(at + KST);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withDate ? `[${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}] ` : `[${hm}] `;
}

/**
 * Compact transcript for the LLM: one line per message, no ids, no JSON, capped at `maxChars` (oldest lines are
 * dropped first, with a note). System lines read "· 해피님이 들어왔어요".
 */
export function transcript(messages: ChatMessage[], opts: { maxChars?: number; maxLine?: number } = {}): string {
  const maxChars = opts.maxChars ?? 3600;
  const maxLine = opts.maxLine ?? 220;
  const days = new Set(messages.filter((m) => m.at).map((m) => new Date(m.at! + KST).toISOString().slice(0, 10)));
  const withDate = days.size > 1;
  const lines = messages.map((m) => {
    const ts = stamp(m.at, withDate);
    if (m.kind === "system") return `${ts}· ${clip(m.text, maxLine)}`;
    return `${ts}${m.isMe ? "나" : m.senderName}: ${lineText(m, maxLine)}`;
  });
  let total = 0;
  let start = lines.length;
  while (start > 0 && total + lines[start - 1]!.length + 1 <= maxChars) {
    total += lines[start - 1]!.length + 1;
    start--;
  }
  const kept = lines.slice(start);
  return (start > 0 ? [`(이전 메시지 ${start}개 생략)`, ...kept] : kept).join("\n");
}

// ───────────────────────────── card thread ─────────────────────────────

/**
 * The card's thread: provider ids replaced by opaque keys (m1… for messages, p1… per sender), text clipped, and the
 * highlight ids mapped to the new keys.
 */
export function cardThread(messages: ChatMessage[], highlightIds: string[], opts: { maxText?: number } = {}): { thread: MessengerMessage[]; highlights: string[] } {
  const maxText = opts.maxText ?? 600;
  const senders = new Map<string, string>();
  const idMap = new Map<string, string>();
  const thread = messages.map((m, i) => {
    const key = `m${i + 1}`;
    idMap.set(m.id, key);
    let sender = "";
    if (m.kind !== "system") {
      const k = m.isMe ? "me" : m.senderId || m.senderName;
      sender = senders.get(k) ?? (m.isMe ? "me" : `p${senders.size + 1}`);
      senders.set(k, sender);
    }
    const out: MessengerMessage = {
      id: key,
      ...(m.at ? { at: m.at } : {}),
      senderId: sender,
      senderName: m.kind === "system" ? "" : m.isMe ? "나" : m.senderName,
      isMe: m.isMe,
      kind: m.kind,
      text: clip(m.text, maxText),
    };
    if (m.senderFull && m.senderFull !== m.senderName && !m.isMe) out.senderFull = clip(m.senderFull, 80);
    if (m.replyTo) out.replyTo = { senderName: m.replyTo.isMe ? "나" : m.replyTo.senderName, text: clip(m.replyTo.text, 120) };
    if (m.attachment) out.attachment = { label: clip(m.attachment.label, 80) };
    return out;
  });
  return { thread, highlights: highlightIds.map((id) => idMap.get(id)).filter((x): x is string => !!x) };
}
