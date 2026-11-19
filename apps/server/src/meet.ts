/**
 * Google Meet participation through the browser bot (services/meet, docs/architecture/MEET-CONTRACT.md §3).
 *
 *  - `sys_join_meet` (approval-gated) creates the meeting thread ("회의 참여"), asks the bot to join and follows
 *    the bot's SSE stream in the background until the meeting ends — independent of the chat turn.
 *  - Every utterance the bot transcribes is stored (`meet_utterances`) and posted to the thread in one
 *    "회의록" message a minute.
 *  - Calling the agent by name ("모시야", whisper's "모시아", or the user's own agent name) → one model call
 *    (no tools, no hidden reasoning, spoken style, at most two sentences) → `/say`, sentence by sentence as the
 *    model streams. "모시 그만" / "잠깐" while it speaks → `/say/stop`.
 *  - Turn-taking (MEET-CONTRACT.md §3 "말 차례 지키기"): the name plus a leave imperative → LEAVE_LINE, then leave
 *    (reason "asked"); an unfinished line for 모시 waits for the rest of the turn (turnIncomplete, PendingTurn); an
 *    answer the speaker talks into before its first sentence is given up and joined to what follows; 모시 stops when
 *    talked over (yieldSyllables) and never starts on top of someone.
 *  - When the meeting ends the agent posts a summary (decisions, action items with owners, next dates).
 *  - `sys_meet_say` / `sys_leave_meet` exist only while the user has a meeting in progress.
 * Logs carry states, counts and timings only: never transcript text, participant names or the full meeting
 * code (`abc-****-hij`).
 */
import type { ToolContext, ToolDef, ToolResult } from "@pickle/agent";
import { scrubSecrets } from "@pickle/agent";
import { turnIncomplete } from "@pickle/protocol";
import { addressesOthers, looksLikeAsk, type AddresseeResult } from "./meetAddressee.ts";
import type { Core } from "./core.ts";
import { publishMessage, publishThread, quotaExceeded } from "./core.ts";
import { DAY_MS, kstDate, kstParts, quotaDay } from "./kst.ts";
import { errInfo } from "./log.ts";
import { runMeetTurn, SupersededTurn } from "./meetAgent.ts";
import { iGa, ieyo, josa, newId } from "./util.ts";

export const DEFAULT_MEET_BOT_URL = "http://127.0.0.1:8781";
export const DEFAULT_STT_URL = "http://127.0.0.1:8782";
/** the bot's /say limit */
export const MEET_SAY_MAX_CHARS = 600;
/** what the model sees around a wake word */
export const WAKE_CONTEXT_MS = 3 * 60_000;

/**
 * Stock lines the bot plays from its clip cache, without TTS. The cache matches the exact string (after NFC and trim,
 * punctuation included), so always use these constants; anything else goes through normal TTS (a few hundred ms).
 */
export const MEET_ACKS = {
  yes: "네,",
  wait: "네, 잠시만요.",
  um: "음,",
  listening: "네, 듣고 있을게요.",
  search: "찾아볼게요.",
  /** a "네," and then nothing for stallMs: said once so the silence doesn't feel dead (cached once the bot lists it) */
  hold: "잠시만요.",
} as const;

/** MEET_CONVERSATION_IDLE_MS: conversation mode ends after this long without a line for 모시 (default 90 s, min 10 s). */
export function idleMsFromEnv(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 10_000 ? Math.round(n) : undefined;
}

/** MEET_TURN_HOLD_MS: how long an unfinished line for 모시 waits for more speech (default 1500; 0–10000, 0 = no wait). */
export function turnHoldMsFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? Math.round(n) : undefined;
}

/** MEET_YIELD_SYLLABLES: 모시 stops talking when someone says this many syllables over it (default 6; 0 = never). */
export function yieldSyllablesFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
}

/**
 * Model for meeting answers and summaries (`PICKLE_MEET_MODEL`). Since 3db542b it defaults to the same model as chat;
 * it stays a separate setting so meetings can be pinned to a fast model independently of chat.
 * Measured 2026-11-12 on OpenGateway with the wake-word prompt: deepseek-v4.1-flash-ultrafast took 0.09 s to its
 * first token; deepseek-v4.1-flash-eco, the old chat default, took 5–30 s (glm-5.3-flash-ultrafast 0.3–0.45 s,
 * claude-haiku-5-5 0.6 s). A separate client is only built when the two settings differ (main.ts).
 */
export const DEFAULT_MEET_MODEL = "deepseek/deepseek-v4.1-flash-ultrafast";

export function meetModelFromEnv(raw: string | undefined): string {
  return raw?.trim() || DEFAULT_MEET_MODEL;
}

/** `MEET_BOT_URL` / `STT_URL`: unset → the default, "off" → null (disabled), otherwise an http(s) base URL. */
export function serviceUrlFromEnv(raw: string | undefined, fallback: string): string | null {
  const v = raw?.trim();
  if (!v) return fallback;
  if (/^(off|0|false|none|disabled?)$/i.test(v)) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return v.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// ───────────────────────────── meeting codes ─────────────────────────────

/** "https://meet.google.com/abc-defg-hij?authuser=0", "meet.google.com/abcdefghij", "abc-defg-hij" → the canonical URL. */
export function parseMeetUrl(raw: unknown): { code: string; url: string } | null {
  const s = String(raw ?? "").trim();
  const m =
    /^(?:https?:\/\/)?meet\.google\.com\/([a-z]{3})-?([a-z]{4})-?([a-z]{3})(?:[/?#].*)?$/i.exec(s) ?? /^([a-z]{3})-([a-z]{4})-([a-z]{3})$/i.exec(s);
  if (!m) return null;
  const code = `${m[1]}-${m[2]}-${m[3]}`.toLowerCase();
  return { code, url: `https://meet.google.com/${code}` };
}

/** For logs: "abc-****-hij". */
export function maskMeetCode(code: string): string {
  const p = code.split("-");
  return p.length === 3 ? `${p[0]}-****-${p[2]}` : "***";
}

// ───────────────────────────── wake word / barge-in ─────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Exact call anywhere in the utterance: "모시야", "모시아" (whisper), "모시님", "모시 씨", "모시," or a bare "모시" at a word
 * boundary — but not the verb ("모시고", "모시는", "모셔"). `names`: the user's agent name plus "모시".
 */
export function wakeRegex(names: string[]): RegExp {
  const alts = cleanNames(names).map((n) => [...n].map(escapeRe).join("\\s?"));
  return new RegExp(`(?:^|[^가-힣])(?:${alts.join("|")})(?:\\s?(?:야|아|님|씨|요)|(?=[\\s,.!?~…]|$))`);
}

const cleanNames = (names: string[]) => [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);

// Hangul syllable = 0xAC00 + (initial × 21 + medial) × 28 + final. Sounds whisper confuses in a short name:
const INITIAL_FUZZ: number[][] = [
  [0, 1, 15], // ㄱ ㄲ ㅋ
  [3, 4, 16], // ㄷ ㄸ ㅌ
  [7, 8, 17], // ㅂ ㅃ ㅍ
  [9, 10], // ㅅ ㅆ
  [12, 13, 14], // ㅈ ㅉ ㅊ
  [2, 5], // ㄴ ㄹ
];
const INITIAL_EXTRA: Record<number, number[]> = { 6: [11], 18: [11] }; // ㅁ→ㅇ ("모시야" heard as "오시야"/"5시야"), ㅎ→ㅇ
const MEDIAL_FUZZ: number[][] = [
  [8, 13, 4, 14], // ㅗ ㅜ ㅓ ㅝ ("모/무/머/뭐")
  [1, 5, 3, 7], // ㅐ ㅔ ㅒ ㅖ
  [0, 2], // ㅏ ㅑ
  [6, 4], // ㅕ ㅓ
  [20, 19], // ㅣ ㅢ
  [12, 17], // ㅛ ㅠ
  [10, 11, 15], // ㅙ ㅚ ㅞ
  [16, 20], // ㅟ ㅣ
];
/** nasal finals (ㄴ ㅁ ㅇ) are often swallowed: "깽이" heard as "깨이" */
const FINAL_DROPPABLE = new Set([4, 16, 21]);
/** whisper writes Sino-Korean number syllables as digits ("모시야" → "5시야") */
const DIGITS: Record<string, string> = { 일: "1", 이: "2", 삼: "3", 사: "4", 오: "5", 육: "6", 칠: "7", 팔: "8", 구: "9", 십: "10" };

function fuzzGroup(groups: number[][], v: number): number[] {
  return groups.find((g) => g.includes(v)) ?? [v];
}

/** Regex source for one syllable and the syllables whisper may write instead. */
export function fuzzSyllable(ch: string): string {
  const code = ch.charCodeAt(0) - 0xac00;
  if (ch.length !== 1 || code < 0 || code > 11171) return escapeRe(ch);
  const ini = Math.floor(code / 588);
  const med = Math.floor((code % 588) / 28);
  const fin = code % 28;
  const inis = [...new Set([...fuzzGroup(INITIAL_FUZZ, ini), ...(INITIAL_EXTRA[ini] ?? [])])];
  const out = new Set<string>();
  const fins = FINAL_DROPPABLE.has(fin) ? [fin, 0] : [fin];
  for (const i of inis) for (const m of fuzzGroup(MEDIAL_FUZZ, med)) for (const f of fins) out.add(String.fromCharCode(0xac00 + (i * 21 + m) * 28 + f));
  const alts = [`[${[...out].join("")}]`];
  for (const syl of out) if (DIGITS[syl]) alts.push(DIGITS[syl]);
  return alts.length === 1 ? alts[0]! : `(?:${alts.join("|")})`;
}

const VOCATIVE = "(?:야|아|자|여)";

export interface WakeWords {
  /** the name, said correctly, anywhere (see wakeRegex) */
  exact: RegExp;
  /**
   * A misheard call, only at the START of an utterance and only when more words follow in it: "5시야, 정리해 줘",
   * "무시아 다음 안건 뭐였지?", "모시자 …". A bare "5시야." is an answer about the time, not a call.
   */
  fuzzy: RegExp;
  /** a misheard name at the start, vocative optional ("무시 그만") — barge-in only */
  fuzzyName: RegExp;
}

export function wakeWords(names: string[]): WakeWords {
  const fuzzed = cleanNames(names).map((n) => [...n].map(fuzzSyllable).join("\\s?"));
  const name = `(?:${fuzzed.join("|")})`;
  return {
    exact: wakeRegex(names),
    fuzzy: new RegExp(`^\\s*${name}\\s?${VOCATIVE}(?=[\\s,.!?~…]+[^\\s,.!?~…])`),
    fuzzyName: new RegExp(`^\\s*${name}\\s?${VOCATIVE}?`),
  };
}

export function isWakeCall(text: string, w: WakeWords): boolean {
  return w.exact.test(text) || w.fuzzy.test(text);
}

const FILLER_ONLY = /^(?:음+|어+|아+|저기요?|저|그|자|여기요?|혹시)?$/;

/**
 * Only the call, nothing asked yet ("모시야.", "모시야, 음", "모시님?"): with real-time STT a pause after the name ends
 * the utterance, and the question comes as the next transcript.
 */
export function isBareCall(text: string, w: WakeWords): boolean {
  if (!w.exact.test(text)) return false;
  const rest = text.replace(new RegExp(w.exact.source, "g"), " ").replace(/[\s\p{P}\p{S}]+/gu, "");
  return FILLER_ONLY.test(rest);
}

const BACKCHANNELS = new Set(
  "음 음음 아 아아 어 어어 네 네네 넵 예 응 응응 엉 오 와 흠 아하 그렇구나 그렇군요 그렇죠 그쵸 맞아 맞아요 그래 그래요 좋아요 좋네요 알겠어요 오케이 그러네요 그러게요".split(" "),
);

/** A filler or backchannel ("음", "네네", "그렇구나"), or ≤ 2 syllables that isn't a question: never for 모시. */
export function isFiller(text: string): boolean {
  const t = text.replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!t) return true;
  if (BACKCHANNELS.has(t)) return true;
  return [...t].length <= 2 && !/[?？]\s*$/.test(text.trim());
}

const DISMISS_RE = /(조용히|조용해|듣고만|듣기만|들어가\s*있|들어가도|(?:이제|다)\s*됐어|그만\s*(?:얘기|말|해도)|이제\s*그만|충분해|우리끼리|저희끼리)/;

/** The name plus "be quiet / that's enough" ("모시야 이제 됐어", "모시 조용히 해"): back to listening, no classifier needed. */
export function isDismissCall(text: string, w: WakeWords): boolean {
  return DISMISS_RE.test(text) && (w.exact.test(text) || w.fuzzyName.test(text));
}

const STOP_WORDS = /(그만|멈춰|스톱|조용|stop)/i;
const HOLD_AT_START = /^\s*(잠깐|잠깐만|잠시만|그만|스톱)/;

/** "모시 그만", "무시 그만", "잠깐만요" — only meaningful while the agent is speaking. */
export function isStopRequest(text: string, w: WakeWords): boolean {
  return HOLD_AT_START.test(text) || isStopCall(text, w);
}

/** The name plus a stop word ("모시 그만"): never a question, even when the agent is silent. */
export function isStopCall(text: string, w: WakeWords): boolean {
  return STOP_WORDS.test(text) && (w.exact.test(text) || w.fuzzyName.test(text));
}

// ───────────────────────────── leaving / turn-taking ─────────────────────────────

/**
 * "나가 줘", "나가도 돼", "먼저 나가 있어", "회의에서 나가.", "퇴장해", "이만 가 봐": an imperative to leave the meeting.
 * "봐야" is "have to" ("저는 3시에 나가 봐야 해서요", "이제 가 봐야 할 시간이네"), never an imperative.
 */
const LEAVE_RE = new RegExp(
  [
    String.raw`나가\s?(?:줘|주세요|줄래|주실래|주시겠|주실\s?수|도\s?(?:돼|되|괜찮|좋)|있어|있으세요|계세요|봐(?!야)|보세요|세요|셔도|셔야|라)`,
    String.raw`나가[\s.!~]*$`,
    String.raw`퇴장\s?(?:해|하세요|해\s?줘|해\s?주세요|해도|하셔도)`,
    String.raw`(?:회의에서|여기서)\s?빠져`,
    String.raw`(?:이만|먼저|그만|이제)\s?가\s?(?:봐(?!야)|보세요|도\s?(?:돼|되|괜찮))`,
  ].join("|"),
);
/** a question, a negation ("안 나가도 돼", "나가지 마") or the speaker leaving themselves ("저 먼저 나가") */
const NOT_LEAVE = /[?？]|안\s?(?:나가|가도|퇴장)|(?:나가|가|퇴장하)지\s?마|나가면\s?안|(?:^|\s)(?:나|저|제가|내가|저는|나는|저희는?|우리는?)\s+(?:(?:먼저|이만|이제|좀)\s+)?나가/;

/** a leave imperative, name or not (conversation mode also needs a verdict other than "other") */
export function isLeaveRequest(text: string): boolean {
  return LEAVE_RE.test(text) && !NOT_LEAVE.test(text);
}

/** "모시야 이제 나가도 돼", "모시 퇴장해": the name (exact, or misheard at the start) plus a leave imperative */
export function isLeaveCall(text: string, w: WakeWords): boolean {
  return isLeaveRequest(text) && isWakeCall(text, w);
}

/** what 모시 says before it leaves when asked (normal TTS, kept in the minutes) */
export const LEAVE_LINE = "네, 이만 나갈게요. 회의록은 앱에 정리해 둘게요.";

/** an unfinished line ("모시야 그 문서를") waits for the rest of the turn: the rule is shared with the app's voice call */
export { turnIncomplete };

/** words that don't count as talking over 모시 or as going on: backchannels, reactions, thanks */
const REACTIONS = new Set([
  ...BACKCHANNELS,
  ..."진짜 진짜요 대박 헐 어머 그래그래 맞아맞아 그러네 그렇네 그렇네요 그렇지 그치 그럼요 물론이죠 좋네 좋아 고마워 고마워요 감사합니다 감사해요 알겠습니다 넵넵 예예 응응 오오 아아 우와".split(" "),
]);

/**
 * Syllables of real speech in a line: backchannels and reactions ("네네", "아 그렇구나", "고마워요") count 0, a Latin
 * word about one per three letters. Decides when someone is going on (C: 3) or talking over 모시 (D: MEET_YIELD_SYLLABLES).
 */
export function speechSyllables(text: string): number {
  let n = 0;
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/[\p{P}\p{S}]+/gu, "");
    if (!w || REACTIONS.has(w) || /^(?:음+|어+|아+|으+|응+|네+|예+|오+|와+|흠+)$/.test(w)) continue;
    n += (w.match(/[가-힣0-9]/g)?.length ?? 0) + Math.ceil((w.match(/[A-Za-z]+/g)?.join("").length ?? 0) / 3);
  }
  return n;
}

/** What services/stt should be primed with so it writes the name instead of "5시야" (`?prompt=`, via the bot's `sttPrompt`). */
export function sttPromptFor(agent: string): string {
  return `${josa(agent, "아", "야")}, 지금 회의 내용 좀 정리해 줄래?`;
}

/**
 * Whisper sometimes returns its prompt verbatim for short, unclear audio, which would read as a call. A line that
 * matches the prompt but is too long for its audio (> 9 syllables a second) is an echo; someone really saying the
 * prompt sentence takes 2–3 s and is kept. Without timings nothing is dropped. services/stt applies the same rule.
 */
export function isPromptEcho(text: string, prompt: string, durationMs: number | null): boolean {
  const n = (s: string) => s.replace(/[\s\p{P}\p{S}]+/gu, "");
  const t = n(text);
  const p = n(prompt);
  if (!t || !p || !(t === p || (t.length >= 8 && p.includes(t)))) return false;
  return durationMs !== null && durationMs >= 0 && t.length > (durationMs / 1000) * 9;
}

/** What the TTS should read: no markdown, emoji, list markers or URLs; whitespace collapsed. */
export function spokenText(text: string, max = 300): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>|~]+/g, "")
    .replace(/^\s*(?:[-•·]|\d+[.)])\s+/gm, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/(^|\s)[-•·](?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Where the first complete sentence of a streamed reply ends (index after its punctuation), or -1.
 * A sentence ends at . ! ? … followed by whitespace (so "3.5" never splits); `final` accepts the end of text.
 * Sentences shorter than `minChars` are merged into the next one (TTS reads "네." badly on its own).
 */
export function sentenceEnd(buf: string, final = false, minChars = 8): number {
  const re = /[.!?。！？…]+(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf))) {
    const end = m.index + m[0].length;
    if (buf.slice(0, end).trim().length >= minChars) return end;
  }
  if (final && buf.trim()) return buf.length;
  return -1;
}

// ───────────────────────────── plain model calls ─────────────────────────────

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** total tokens of the call, for the user's daily quota */
  onUsage?: (totalTokens: number) => void;
}

interface StreamingClient {
  stream(req: {
    messages: { role: "system" | "user"; content: string }[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    thinking?: boolean;
  }): AsyncIterable<{ type: string; delta?: string; usage?: { totalTokens?: number } }>;
}

/** LlmHelpers.chat over @pickle/agent's LlmClient: one call, no tools, hidden reasoning off, text deltas out. */
export function plainChat(client: StreamingClient): (i: ChatRequest) => AsyncIterable<string> {
  return async function* (i) {
    const messages = [
      { role: "system" as const, content: i.system },
      { role: "user" as const, content: i.user },
    ];
    for await (const c of client.stream({ messages, maxTokens: i.maxTokens, temperature: i.temperature, signal: i.signal, thinking: false })) {
      if (c.type === "text" && c.delta) yield c.delta;
      else if (c.type === "usage" && typeof c.usage?.totalTokens === "number") i.onUsage?.(c.usage.totalTokens);
    }
  };
}

// ───────────────────────────── storage ─────────────────────────────

export type MeetState = "launching" | "prejoin" | "waiting_admission" | "in_call" | "ended" | "denied" | "blocked" | "invalid" | "failed";
const ACTIVE_STATES = ["launching", "prejoin", "waiting_admission", "in_call"];
const KNOWN_STATES = new Set<string>([...ACTIVE_STATES, "ended", "denied", "blocked", "invalid", "failed"]);
const isActive = (s: string) => ACTIVE_STATES.includes(s);

export interface MeetingRow {
  id: string;
  user_id: string;
  thread_id: string;
  session_id: string | null;
  code: string;
  purpose: string;
  state: string;
  reason: string | null;
  participants: number | null;
  last_seq: number;
  started_at: number;
  joined_at: number | null;
  ended_at: number | null;
  /** the Meet page title, once the bot has seen it (schema v3) */
  title: string | null;
  /** the chat thread the join was asked in, and the approval that let it (schema v5; null on older rows) */
  origin_thread_id: string | null;
  approval_id: string | null;
}

export interface UtteranceRow {
  seq: number | null;
  speaker: string | null;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
  at: number;
  /** "heard" (from the meeting) or "said" (the agent's own words) */
  role: string;
}

// ───────────────────────────── the meeting manager ─────────────────────────────

interface Line {
  speaker: string | null;
  text: string;
  at: number;
  self: boolean;
}

/**
 * One utterance as real-time STT reveals it: `partial` events, then `endpoint` (the speaker stopped for 0.3 s), then its
 * final `transcript` (same seq).
 */
interface Utterance {
  /** a call was seen in a partial: the "네," goes out at the endpoint, never while the speaker is still talking */
  wake: boolean;
  /** the "네," for this utterance, once sent */
  ack: Promise<string | null> | null;
  ackAt: number | null;
  ackOn: "endpoint" | "transcript" | null;
  /** barge-in already handled on a partial */
  stopped: boolean;
  /** the latest partial text */
  text: string;
  /** conversation mode: the addressee check started at the endpoint on `verdictText` (the last partial) */
  verdict: Promise<AddresseeResult | null> | null;
  verdictText: string;
  /** who the endpoint said was speaking (null: it didn't say); the speaker changes the verdict a lot */
  verdictSpeaker: string | null;
  /** 모시 already stopped talking over this utterance (D): once per utterance */
  yielded: boolean;
}

const newUtterance = (): Utterance => ({
  wake: false,
  ack: null,
  ackAt: null,
  ackOn: null,
  stopped: false,
  text: "",
  verdict: null,
  verdictText: "",
  verdictSpeaker: null,
  yielded: false,
});

/**
 * listening: transcribe only; a call (the name) starts a conversation. conversation: lines without the name are
 * answered too when the addressee check says they're for 모시; "이제 됐어"-style lines or 90 s with nothing for 모시
 * end it. "모시 그만" only stops the speech in progress.
 */
export type MeetMode = "listening" | "conversation";

/**
 * A line for 모시 that the speaker hasn't finished: a bare call ("모시야." — the question usually follows in the next
 * transcript), a call or follow-up that stops mid-sentence ("모시야 그 문서를", turnIncomplete), or an answer given up
 * because the speaker went on (C). The same speaker's next transcript joins it; it's answered when that makes it
 * complete, after turnHoldMs without speech (callFollowMs for a bare call → "말씀하세요."), or turnMaxMs after firstAt.
 */
interface PendingTurn {
  speaker: string | null;
  text: string;
  /** the utterance whose "네," covers the turn */
  utt: Utterance;
  kind: "call" | "followup";
  /** the name alone so far */
  bare: boolean;
  /** performance.now() when the turn was first held */
  firstAt: number;
  /** transcripts in it */
  parts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The answer being generated: C gives it up when the speaker goes on before its first real sentence. */
interface Answering {
  ctl: AbortController;
  heard: { speaker: string | null; text: string; at: number };
  utt: Utterance;
  kind: "call" | "followup";
  firstAt: number;
  parts: number;
  /** its first real sentence went to the bot (acks and fillers don't count) */
  spoke: boolean;
  /** a tool with an outside effect started (a document, an approval card): never given up for a continuation */
  committed: boolean;
}

interface Live {
  id: string;
  userId: string;
  threadId: string;
  sessionId: string;
  code: string;
  purpose: string;
  display: string;
  agent: string;
  wake: WakeWords;
  /** what the bot primes STT with (`sttPrompt`); a transcript equal to it is an echo, not speech */
  sttPrompt: string;
  /** the utterance in progress, as seen through `partial` events; handed to `closing` at its endpoint */
  utt: Utterance;
  /** the utterance whose endpoint arrived and whose transcript (same seq) is due next */
  closing: { seq: number | null; utt: Utterance } | null;
  /** a line for 모시 waiting for the rest of the turn (see PendingTurn) */
  turn: PendingTurn | null;
  /** the answer in progress, until it ends (see Answering) */
  answering: Answering | null;
  /** sayIds of answer sentences (not acks or fillers) the bot hasn't finished: talking over these makes 모시 yield */
  answerSays: Set<string>;
  /** the latest sayIds the bot finished playing, and who waits for one */
  played: string[];
  playWaiters: Map<string, () => void>;
  /** performance.now() of the latest partial, and who waits for the endpoint of the utterance in progress */
  partialAt: number;
  endpointWaiters: (() => void)[];
  /** asked to leave ("asked") or left from the app ("left"): nothing more is answered; the end note uses this reason */
  leaving: string | null;
  mode: MeetMode;
  /** `at` of the latest call: the addressee check reads the meeting from here (what came before isn't the conversation) */
  convoFrom: number;
  /** conversation mode ends when this fires (re-armed by every line for 모시 and every answer) */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** thread notes for mode changes come in pairs (entered → left), at most one pair per modeNoteMs */
  modeNote: { shown: boolean; at: number };
  ctl: AbortController;
  lastSeq: number;
  /** sayIds the bot reports as speaking */
  speaking: Set<string>;
  /** the wake-word answer being generated / spoken */
  reply: AbortController | null;
  pending: Line[];
  flushTimer: ReturnType<typeof setInterval> | null;
  joined: boolean;
  finished: boolean;
  /** `state: ended` arrived; the `ended` event with the real reason normally follows on the same stream */
  endedReason: string | null;
  /** the Meet page title is stored (or the bot can't tell us any more) */
  titled: boolean;
}

export interface MeetTimings {
  /** post buffered transcript lines to the thread this often */
  flushMs: number;
  /** first reconnect delay after the SSE stream drops (doubles up to reconnectMaxMs) */
  reconnectMs: number;
  reconnectMaxMs: number;
  /** no bytes (not even a heartbeat) for this long → reconnect */
  staleMs: number;
  /** give up and close the meeting when the bot stays unreachable this long */
  lostAfterMs: number;
  /** a wake-word answer is abandoned after this long */
  replyTimeoutMs: number;
  /** HTTP calls to the bot */
  requestTimeoutMs: number;
  /** after a bare call ("모시야."), how long the next transcript counts as its question */
  callFollowMs: number;
  /** conversation mode ends after this long without a line for 모시 (MEET_CONVERSATION_IDLE_MS) */
  conversationIdleMs: number;
  /** an answer that starts without a "네," gets one only if its first sentence isn't ready within this (0: always) */
  ackGraceMs: number;
  /** after a "네,", no first sentence (and no tool filler) for this long → "잠시만요." once (0: never) */
  stallMs: number;
  /** at most one pair of mode notes ("대화에 들어왔어요" / "다시 듣기만 할게요") in the thread per this long */
  modeNoteMs: number;
  /** an unfinished line for 모시 waits this long after the latest speech for the rest (MEET_TURN_HOLD_MS) */
  turnHoldMs: number;
  /** …and at most this long after it was first held */
  turnMaxMs: number;
  /** someone says this many syllables (not backchannels) while 모시 speaks an answer → 모시 stops (MEET_YIELD_SYLLABLES, 0 = never) */
  yieldSyllables: number;
  /** a partial this recent without its endpoint: someone is talking, 모시's first sentence waits for the endpoint */
  talkOverMs: number;
  /** …at most this long */
  talkOverMaxMs: number;
  /** asked to leave: the goodbye line plays at most this long before 모시 leaves */
  leaveSayMaxMs: number;
}

/** C: syllables of real speech before the first sentence that mean the speaker is going on */
const CONTINUE_SYLLABLES = 3;

const DEFAULT_TIMINGS: MeetTimings = {
  flushMs: 60_000,
  reconnectMs: 500,
  reconnectMaxMs: 10_000,
  staleMs: 60_000,
  lostAfterMs: 2 * 60_000,
  replyTimeoutMs: 20_000,
  requestTimeoutMs: 8_000,
  callFollowMs: 4_000,
  conversationIdleMs: 90_000,
  ackGraceMs: 350,
  stallMs: 2_500,
  modeNoteMs: 120_000,
  turnHoldMs: 1_500,
  turnMaxMs: 10_000,
  yieldSyllables: 6,
  talkOverMs: 600,
  talkOverMaxMs: 3_000,
  leaveSayMaxMs: 8_000,
};

type ServiceHealth = "ready" | "loading" | "missing" | "off";

const STATE_NOTES: Record<string, string> = {
  waiting_admission: "참여 요청을 보냈어요. 호스트가 수락하면 들어가요.",
  in_call: "회의에 들어왔어요. 지금부터 받아 적을게요.",
  denied: "호스트가 참여 요청을 받아 주지 않았어요.",
  blocked: "이 회의에는 들어갈 수 없다고 나와요. 같은 조직 계정만 들어갈 수 있는 회의일 수 있어요.",
  invalid: "회의를 찾을 수 없어요. 회의 코드가 맞는지, 이미 끝난 회의는 아닌지 확인해 주세요.",
  failed: "회의에 참여하지 못했어요. 잠시 후 다시 시도해 주세요.",
};

/** failure reasons the bot reports (services/meet flow.ts) that deserve their own wording */
const REASON_NOTES: Record<string, string> = {
  call_full: "회의 인원이 가득 차서 들어갈 수 없어요.",
  signin_required: "로그인한 계정만 들어갈 수 있는 회의예요. 회의 참여용 구글 계정에 먼저 로그인해야 해요.",
  removed: "호스트가 참여 요청을 거절했어요.",
  host_denied: "호스트가 참여 요청을 받아 주지 않았어요.",
  admission_timeout: "5분 동안 수락되지 않아서 참여 요청을 거뒀어요.",
  no_response: "5분 동안 수락되지 않아서 참여 요청을 거뒀어요.",
  network_unavailable: "회의 페이지를 열지 못했어요. 잠시 뒤 다시 시도해 주세요.",
};

const END_NOTES: Record<string, string> = {
  left: "회의에서 나왔어요.",
  asked: "회의에서 나가 달라는 말을 듣고 나왔어요.",
  kicked: "회의에서 내보내졌어요.",
  meeting_ended: "회의가 끝나서 나왔어요.",
  alone: "혼자 남은 지 2분이 지나서 회의에서 나왔어요.",
  error: "문제가 생겨서 회의에서 나왔어요.",
  lost: "회의 참여 서비스와 연결이 끊겨서 회의를 마쳤어요.",
};

/** a join's approval is looked up among the decisions of the last few minutes (the resumed turn runs right after) */
const JOIN_APPROVAL_WINDOW_MS = 10 * 60_000;

/**
 * The sentence the '회의 참여' thread shows for a meeting's state — the same one #closeRow posts at the end (and the
 * follow loop on the way in) — or null while it is still starting. Fixed wording: no code, no names.
 */
export function meetNote(state: string, reason: string | null): string | null {
  if (state === "ended") return END_NOTES[reason ?? ""] ?? END_NOTES.meeting_ended!;
  if (state === "invalid" && reason === "meeting_ended") return "이미 끝난 회의예요.";
  if (state === "in_call" || state === "waiting_admission") return STATE_NOTES[state]!;
  if (isActive(state)) return null;
  return REASON_NOTES[reason ?? ""] ?? STATE_NOTES[state] ?? STATE_NOTES.failed!;
}

function hhmm(ms: number): string {
  const p = kstParts(ms);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal.aborted) return res();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      res();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export class MeetHub {
  readonly timings: MeetTimings = { ...DEFAULT_TIMINGS };
  readonly #core: Core;
  readonly #live = new Map<string, Live>();
  #health: { meet: ServiceHealth; stt: ServiceHealth; at: number; probing: boolean } = { meet: "missing", stt: "missing", at: 0, probing: false };

  constructor(core: Core) {
    this.#core = core;
    const idle = core.cfg.meet?.conversationIdleMs;
    if (idle) this.timings.conversationIdleMs = idle;
    const hold = core.cfg.meet?.turnHoldMs;
    if (hold !== undefined) this.timings.turnHoldMs = hold;
    const yieldAt = core.cfg.meet?.yieldSyllables;
    if (yieldAt !== undefined) this.timings.yieldSyllables = yieldAt;
  }

  get #base(): string | null {
    return this.#core.cfg.meet?.url ?? null;
  }

  // ── queries ──

  /** The user's meeting that hasn't finished yet (launching … in_call), if any. */
  active(userId: string): MeetingRow | null {
    return (
      this.#core.db.sql
        .query<MeetingRow, [string]>(
          `SELECT * FROM meetings WHERE user_id = ? AND state IN ('launching','prejoin','waiting_admission','in_call') ORDER BY started_at DESC LIMIT 1`,
        )
        .get(userId) ?? null
    );
  }

  /** listening or conversation, for a meeting being followed (null otherwise) */
  mode(meetingId: string): MeetMode | null {
    return this.#live.get(meetingId)?.mode ?? null;
  }

  meeting(id: string): MeetingRow | null {
    return this.#core.db.sql.query<MeetingRow, [string]>(`SELECT * FROM meetings WHERE id = ?`).get(id) ?? null;
  }

  utterances(meetingId: string, sinceAt = 0): UtteranceRow[] {
    return this.#core.db.sql
      .query<UtteranceRow, [string, number]>(
        `SELECT seq, speaker, text, start_ms, end_ms, at, role FROM meet_utterances WHERE meeting_id = ? AND at >= ? ORDER BY id`,
      )
      .all(meetingId, sinceAt);
  }

  /** The user's meetings, newest first (sys_meet_notes, the prompt note). */
  recent(userId: string, limit = 5): MeetingRow[] {
    return this.#core.db.sql
      .query<MeetingRow, [string, number]>(`SELECT * FROM meetings WHERE user_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`)
      .all(userId, limit);
  }

  /** Any meeting row at all: sys_meet_notes and the prompt note are offered from then on. */
  hasMeetings(userId: string): boolean {
    return this.#core.db.sql.query<{ one: number }, [string]>(`SELECT 1 AS one FROM meetings WHERE user_id = ? LIMIT 1`).get(userId) !== null;
  }

  /** The newest meeting with something written down (a failed join right after doesn't hide it), else the newest. */
  latest(userId: string): MeetingRow | null {
    return (
      this.#core.db.sql
        .query<MeetingRow, [string]>(
          `SELECT * FROM meetings m WHERE user_id = ? AND EXISTS (SELECT 1 FROM meet_utterances u WHERE u.meeting_id = m.id)
           ORDER BY started_at DESC, rowid DESC LIMIT 1`,
        )
        .get(userId) ??
      this.recent(userId, 1)[0] ??
      null
    );
  }

  /** The meeting whose '회의 참여' thread this is, if any. */
  byThread(userId: string, threadId: string): MeetingRow | null {
    return (
      this.#core.db.sql
        .query<MeetingRow, [string, string]>(`SELECT * FROM meetings WHERE user_id = ? AND thread_id = ? ORDER BY started_at DESC LIMIT 1`)
        .get(userId, threadId) ?? null
    );
  }

  /** The meeting a join card in `originThreadId` started (meeting B), if any. */
  byApproval(userId: string, originThreadId: string, approvalId: string): MeetingRow | null {
    return (
      this.#core.db.sql
        .query<MeetingRow, [string, string, string]>(
          `SELECT * FROM meetings WHERE user_id = ? AND origin_thread_id = ? AND approval_id = ? ORDER BY started_at DESC LIMIT 1`,
        )
        .get(userId, originThreadId, approvalId) ?? null
    );
  }

  /**
   * The approval behind the join that is starting now. sys_join_meet is approval-gated and POST /api/approvals/:id
   * resumes the turn in the card's thread right after the decision, so it is the latest join for this meeting code
   * approved in that thread that no meeting claims yet. Null when there is none (a join outside an approval).
   * "Latest" is exact because decide() holds the user's lease from before resolveApproval until the resumed turn
   * ends: a second approval meanwhile is refused (409 busy) and stays unresolved. The code match keeps it right even
   * if that ever changes (the card's spec carries `meet.code` whenever the link parses, and join() needs it to).
   */
  #joinApproval(userId: string, threadId: string, code: string, now: number): string | null {
    const row = this.#core.db.sql
      .query<{ id: string }, [string, string, number, string]>(
        `SELECT a.id FROM approvals a
         WHERE a.user_id = ? AND a.thread_id = ? AND a.status = 'approved' AND a.resolved_at >= ?
           AND json_extract(a.call_json, '$.function.name') = 'sys_join_meet'
           AND json_extract(a.spec_json, '$.meet.code') = ?
           AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.user_id = a.user_id AND m.approval_id = a.id)
         ORDER BY a.resolved_at DESC, a.rowid DESC LIMIT 1`,
      )
      .get(userId, threadId, now - JOIN_APPROVAL_WINDOW_MS, code);
    return row?.id ?? null;
  }

  lineCount(meetingId: string): number {
    return this.#core.db.sql.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM meet_utterances WHERE meeting_id = ?`).get(meetingId)?.n ?? 0;
  }

  /** The end summary posted to the meeting thread ("**회의 요약**" assistant row), without its heading. */
  summaryText(row: MeetingRow): string | null {
    const m = this.#core.db.sql
      .query<{ text: string }, [string]>(
        `SELECT text FROM messages WHERE thread_id = ? AND role = 'assistant' AND text LIKE '**회의 요약**%' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(row.thread_id);
    const t = m?.text.replace(/^\*\*회의 요약\*\*\s*/, "").trim();
    return t ? t : null;
  }

  /** /api/health: last probe of services/meet and services/stt; a stale probe refreshes in the background. */
  health(): { meet: ServiceHealth; stt: ServiceHealth } {
    const now = Date.now();
    if (!this.#health.probing && now - this.#health.at > 30_000) {
      this.#health.probing = true;
      void this.probe().finally(() => (this.#health.probing = false));
    }
    return { meet: this.#core.cfg.meet ? this.#health.meet : "off", stt: this.#core.cfg.stt ? this.#health.stt : "off" };
  }

  async probe(): Promise<{ meet: ServiceHealth; stt: ServiceHealth }> {
    const get = async (url: string | undefined): Promise<Record<string, unknown> | null> => {
      if (!url) return null;
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
        return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    const [m, s] = await Promise.all([get(this.#core.cfg.meet?.url), get(this.#core.cfg.stt?.url)]);
    // strict shapes: something else answering on the port (another dev server) must not look healthy
    this.#health.meet = !this.#core.cfg.meet ? "off" : m?.ok === true && m.chrome === "ready" ? "ready" : "missing";
    this.#health.stt = !this.#core.cfg.stt ? "off" : s?.ok === true && typeof s.ready === "boolean" ? (s.ready ? "ready" : "loading") : "missing";
    this.#health.at = Date.now();
    return { meet: this.#health.meet, stt: this.#health.stt };
  }

  // ── tool actions ──

  async join(ctx: ToolContext, rawUrl: unknown, rawPurpose: unknown): Promise<ToolResult> {
    const core = this.#core;
    const parsed = parseMeetUrl(rawUrl);
    if (!parsed) {
      return { ok: false, summary: "Google Meet 회의 주소 형식이 아니에요", data: { error: "invalid_url", hint: "meet.google.com/abc-defg-hij 형식의 주소나 회의 코드를 받아 주세요." } };
    }
    const base = this.#base;
    if (!base) {
      return {
        ok: false,
        summary: "회의 참여 기능이 아직 켜져 있지 않아요",
        data: { error: "meet_not_configured", hint: "모시 서비스 쪽 회의 참여 기능이 준비되지 않아 지금은 참여할 수 없다고 짧게 안내하세요." },
      };
    }
    if (this.active(ctx.userId)) {
      return { ok: false, summary: "이미 다른 회의에 참여 중이에요", data: { error: "already_in_meeting", hint: "먼저 sys_leave_meet로 지금 회의에서 나와야 해요." } };
    }
    const purpose = String(rawPurpose ?? "").trim().slice(0, 200);
    const user = core.db.userById(ctx.userId);
    const display = user?.display_name ?? ctx.displayName ?? "사용자";
    const agent = user?.agent_name ?? ctx.agentName ?? "모시";
    const now = core.now();
    const threadId = newId("t");
    core.db.createThread(
      { id: threadId, ownerId: ctx.userId, kind: "call", title: "회의 참여", subtitle: `${agent}의 회의 참여`, icon: "people", now },
      [ctx.userId],
    );
    const id = newId("mt");
    // meeting B: where the join was asked and which approval let it — the join card there follows this meeting
    const approvalId = this.#joinApproval(ctx.userId, ctx.threadId, parsed.code, now);
    core.db.sql
      .query(
        `INSERT INTO meetings (id, user_id, thread_id, code, purpose, state, started_at, origin_thread_id, approval_id)
         VALUES (?, ?, ?, ?, ?, 'launching', ?, ?, ?)`,
      )
      .run(id, ctx.userId, threadId, parsed.code, purpose, now, ctx.threadId || null, approvalId);
    publishThread(core, threadId);
    // stored text: the code masked like the card title (the full code lives only in meetings.code and the approval card)
    this.#note(threadId, ctx.userId, `Google Meet 회의(${maskMeetCode(parsed.code)})에 참여하러 갈게요.${purpose ? `\n목적: ${purpose}` : ""}`);

    const announce = `안녕하세요, ${display}님의 AI 비서 ${ieyo(agent)}. 회의 내용을 받아 적고 있어요. 저를 부르시려면 '${josa(agent, "아", "야")}'라고 불러 주세요.`;
    const res = await this.#bot("POST", "/sessions", { url: parsed.url, name: agent, announce, sttPrompt: sttPromptFor(agent) });
    const body = res ? ((await res.json().catch(() => ({}))) as { id?: unknown; state?: unknown; error?: unknown }) : {};
    if (!res || res.status !== 201 || typeof body.id !== "string") {
      const error = !res ? "meet_unreachable" : res.status === 409 ? "busy" : res.status === 400 ? "invalid_url" : "meet_failed";
      const summary =
        error === "busy"
          ? "회의 참여 봇이 지금 다른 회의에 들어가 있어요"
          : error === "invalid_url"
            ? "회의 주소를 받아 주지 않았어요"
            : error === "meet_unreachable"
              ? "회의 참여 서비스에 연결하지 못했어요"
              : "회의 참여를 시작하지 못했어요";
      core.log.warn("meet join failed", { meeting: maskMeetCode(parsed.code), status: res?.status ?? 0, error });
      core.db.sql.query(`UPDATE meetings SET state = 'failed', reason = ?, ended_at = ? WHERE id = ?`).run(error, core.now(), id);
      this.#note(threadId, ctx.userId, `${summary}. 잠시 후 다시 시도해 주세요.`);
      return { ok: false, summary, data: { error, status: res?.status ?? null } };
    }
    const state = typeof body.state === "string" && KNOWN_STATES.has(body.state) ? body.state : "launching";
    core.db.sql.query(`UPDATE meetings SET session_id = ?, state = ? WHERE id = ?`).run(body.id, state, id);
    core.log.info("meet join", { meeting: maskMeetCode(parsed.code), session: body.id, state });
    const live = this.#makeLive(this.meeting(id)!, display, agent);
    this.#follow(live);
    return {
      ok: true,
      summary: "회의 참여를 시작했어요. 호스트가 수락하면 들어가요",
      data: {
        state,
        background: true,
        hint:
          "회의는 지금부터 백그라운드에서 따로 진행돼요. 이 결과는 참여를 시작한 순간의 상태라서, 나중에 회의 상태나 내용을 물으면 이 결과로 답하지 말고 sys_meet_notes로 확인하세요. " +
          "'회의 참여' 대화방에 진행 상황과 회의록이 올라가고, 회의가 끝나면 요약을 올린다고 짧게 안내하세요.",
      },
    };
  }

  async say(userId: string, rawText: unknown): Promise<ToolResult> {
    const text = spokenText(String(rawText ?? ""), MEET_SAY_MAX_CHARS);
    if (!text) return { ok: false, summary: "전할 말이 비어 있어요", data: { error: "empty_text" } };
    const row = this.active(userId);
    const live = row ? this.#live.get(row.id) : undefined;
    if (!row || !live) return { ok: false, summary: "지금 참여 중인 회의가 없어요", data: { error: "no_meeting" } };
    if (row.state !== "in_call") return { ok: false, summary: "아직 회의에 들어가지 않았어요", data: { error: "not_in_call", state: row.state } };
    const ok = (await this.#say(live, text)) !== null;
    return ok
      ? { ok: true, summary: "회의에서 전했어요", data: { chars: text.length } }
      : { ok: false, summary: "회의에서 말하지 못했어요", data: { error: "say_failed" } };
  }

  async leave(userId: string): Promise<ToolResult> {
    const row = this.active(userId);
    if (!row) return { ok: false, summary: "지금 참여 중인 회의가 없어요", data: { error: "no_meeting" } };
    await this.#exit(row, this.#live.get(row.id), "left");
    return { ok: true, summary: "회의에서 나왔어요", data: { state: "ended" } };
  }

  /** DELETE the bot session and close the meeting with `reason` (the bot's own `ended {reason:"left"}` keeps it). */
  async #exit(row: MeetingRow, live: Live | undefined, reason: string): Promise<void> {
    if (live) live.leaving ??= reason;
    const res = row.session_id ? await this.#bot("DELETE", `/sessions/${encodeURIComponent(row.session_id)}`) : null;
    if (live && res?.ok) {
      // the bot reports `ended` on the stream; finish here too in case the stream is already gone
      const done = new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      await Promise.race([done, this.#waitFinished(live)]);
    }
    if (live && !live.finished) await this.#finish(live, "ended", live.leaving ?? reason);
    else if (!live) this.#closeRow(row, "ended", reason);
  }

  // ── lifecycle ──

  /** After a restart: pick up meetings that were still running (or close them if the bot lost them). */
  start(): void {
    const rows = this.#core.db.sql
      .query<MeetingRow, []>(`SELECT * FROM meetings WHERE state IN ('launching','prejoin','waiting_admission','in_call')`)
      .all();
    for (const row of rows) {
      if (this.#live.has(row.id)) continue;
      if (!row.session_id || !this.#base) {
        this.#closeRow(row, "ended", "lost");
        continue;
      }
      const user = this.#core.db.userById(row.user_id);
      this.#follow(this.#makeLive(row, user?.display_name ?? "사용자", user?.agent_name ?? "모시"));
    }
  }

  /** Stops following (the bot keeps the meeting; start() picks it up again). */
  async close(): Promise<void> {
    for (const live of this.#live.values()) {
      live.ctl.abort();
      this.#dropTurn(live);
      this.#endpointed(live);
      if (live.idleTimer) clearTimeout(live.idleTimer);
      live.reply?.abort();
      if (live.flushTimer) clearInterval(live.flushTimer);
      this.#flush(live);
    }
    this.#live.clear();
  }

  // ── internals ──

  #makeLive(row: MeetingRow, display: string, agent: string): Live {
    const live: Live = {
      id: row.id,
      userId: row.user_id,
      threadId: row.thread_id,
      sessionId: row.session_id ?? "",
      code: row.code,
      purpose: row.purpose,
      display,
      agent,
      wake: wakeWords([agent, "모시"]),
      sttPrompt: sttPromptFor(agent),
      ctl: new AbortController(),
      lastSeq: row.last_seq,
      speaking: new Set(),
      reply: null,
      pending: [],
      flushTimer: null,
      joined: row.joined_at !== null,
      finished: false,
      endedReason: null,
      titled: row.title !== null,
      utt: newUtterance(),
      closing: null,
      turn: null,
      answering: null,
      answerSays: new Set(),
      played: [],
      playWaiters: new Map(),
      partialAt: -Infinity,
      endpointWaiters: [],
      leaving: null,
      mode: "listening",
      convoFrom: 0,
      idleTimer: null,
      modeNote: { shown: false, at: -Infinity },
    };
    this.#live.set(row.id, live);
    if (live.joined) this.#startFlushing(live);
    return live;
  }

  #waiters = new Map<string, (() => void)[]>();
  #waitFinished(live: Live): Promise<void> {
    if (live.finished) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.set(live.id, [...(this.#waiters.get(live.id) ?? []), resolve]));
  }

  async #bot(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response | null> {
    const base = this.#base;
    if (!base) return null;
    try {
      const timeout = AbortSignal.timeout(this.timings.requestTimeoutMs);
      return await fetch(base + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (!signal?.aborted) this.#core.log.warn("meet bot request failed", { method, err: errInfo(err) });
      return null;
    }
  }

  /** Background SSE loop: reconnects with `?since=<last seq>` until the meeting finishes or the bot loses it. */
  #follow(live: Live): void {
    const loop = async () => {
      let delay = this.timings.reconnectMs;
      let downSince: number | null = null;
      while (!live.finished && !live.ctl.signal.aborted) {
        const conn = new AbortController();
        const stop = () => conn.abort();
        live.ctl.signal.addEventListener("abort", stop, { once: true });
        let res: Response | null = null;
        try {
          res = await fetch(`${this.#base}/sessions/${encodeURIComponent(live.sessionId)}/events?since=${live.lastSeq}`, {
            headers: { accept: "text/event-stream" },
            signal: conn.signal,
          });
        } catch {
          res = null;
        }
        if (res?.status === 404) {
          live.ctl.signal.removeEventListener("abort", stop);
          await this.#finish(live, "ended", "lost");
          break;
        }
        if (res?.ok && res.body) {
          downSince = null;
          delay = this.timings.reconnectMs;
          await this.#consume(live, res.body, conn);
          if (!live.finished && live.endedReason) await this.#finish(live, "ended", live.endedReason);
        } else {
          await res?.body?.cancel().catch(() => {});
        }
        conn.abort();
        live.ctl.signal.removeEventListener("abort", stop);
        if (live.finished || live.ctl.signal.aborted) break;
        downSince ??= Date.now();
        if (Date.now() - downSince > this.timings.lostAfterMs) {
          await this.#finish(live, "ended", "lost");
          break;
        }
        this.#core.log.info("meet stream reconnect", { session: live.sessionId, delayMs: delay });
        await sleep(delay, live.ctl.signal);
        delay = Math.min(delay * 2, this.timings.reconnectMaxMs);
      }
    };
    void loop().catch((err) => this.#core.log.error("meet stream failed", { session: live.sessionId, err: errInfo(err) }));
  }

  async #consume(live: Live, body: ReadableStream<Uint8Array>, conn: AbortController): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let stale: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (stale) clearTimeout(stale);
      stale = setTimeout(() => conn.abort(), this.timings.staleMs);
    };
    arm();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        arm();
        buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          let event = "";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (!line || line.startsWith(":")) continue;
            const i = line.indexOf(":");
            const field = i < 0 ? line : line.slice(0, i);
            const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
            if (field === "event") event = value;
            else if (field === "data") data.push(value);
          }
          if (!data.length) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(data.join("\n")) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = event || (typeof payload.type === "string" ? payload.type : "");
          if (await this.#dispatch(live, type, payload)) return;
        }
      }
    } catch {
      /* aborted or dropped: the loop decides */
    } finally {
      if (stale) clearTimeout(stale);
      reader.releaseLock();
    }
  }

  /** true when the meeting is over */
  async #dispatch(live: Live, type: string, d: Record<string, unknown>): Promise<boolean> {
    if (live.finished) return true;
    switch (type) {
      case "state":
        return this.#onState(live, String(d.state ?? ""), typeof d.reason === "string" ? d.reason : null);
      case "partial":
        this.#onPartial(live, d);
        return false;
      case "endpoint":
        this.#onEndpoint(live, d);
        return false;
      case "transcript":
        this.#onTranscript(live, d);
        return false;
      case "speaking": {
        const sayId = String(d.sayId ?? "");
        if (d.on === true) live.speaking.add(sayId);
        else {
          live.speaking.delete(sayId);
          live.answerSays.delete(sayId);
          live.played.push(sayId);
          if (live.played.length > 32) live.played.shift();
          live.playWaiters.get(sayId)?.();
        }
        return false;
      }
      case "participants":
        if (typeof d.count === "number") this.#core.db.sql.query(`UPDATE meetings SET participants = ? WHERE id = ?`).run(d.count, live.id);
        return false;
      case "ended": {
        // a failed join ends with `ended {reason:"error", state:"denied"}` (normally right after `state: denied`)
        const failed = typeof d.state === "string" && KNOWN_STATES.has(d.state) && d.state !== "ended" && !isActive(d.state) ? d.state : null;
        if (failed) await this.#finish(live, failed, failed);
        else await this.#finish(live, "ended", live.endedReason && d.reason === "error" ? live.endedReason : typeof d.reason === "string" ? d.reason : "meeting_ended");
        return true;
      }
      default:
        return false;
    }
  }

  async #onState(live: Live, state: string, reason: string | null): Promise<boolean> {
    if (!KNOWN_STATES.has(state)) return false;
    if (state === "ended") {
      // wait for the `ended` event (it carries the reason: left, kicked, alone, …); the stream closing finishes too
      live.endedReason = reason ?? live.endedReason ?? "meeting_ended";
      return false;
    }
    if (!isActive(state)) {
      await this.#finish(live, state, reason ?? (state === "ended" ? "meeting_ended" : state));
      return true;
    }
    const row = this.meeting(live.id);
    if (!row || row.state === state) return false;
    const core = this.#core;
    core.db.sql.query(`UPDATE meetings SET state = ? WHERE id = ?`).run(state, live.id);
    core.log.info("meet state", { meeting: maskMeetCode(live.code), state });
    if (state === "in_call" && !live.joined) {
      live.joined = true;
      core.db.sql.query(`UPDATE meetings SET joined_at = ? WHERE id = ?`).run(core.now(), live.id);
      this.#startFlushing(live);
      this.#note(live.threadId, live.userId, `${STATE_NOTES.in_call} 회의 중에 '${josa(live.agent, "아", "야")}'라고 부르면 대답해요.`);
    } else if (state === "waiting_admission") {
      this.#note(live.threadId, live.userId, STATE_NOTES.waiting_admission!);
    }
    return false;
  }

  /**
   * Non-final text of the utterance in progress (real-time STT, ≤5/s). "모시 그만" stops speech here already,
   * mid-utterance. A call only marks the utterance: the wake word shows up ~2 s before the speaker finishes, so the
   * "네," waits for the endpoint and the model for the final `transcript`, when the question is complete.
   */
  #onPartial(live: Live, d: Record<string, unknown>): void {
    const text = String(d.text ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
    if (!text || live.leaving) return;
    live.partialAt = performance.now();
    this.#heardSpeech(live);
    const utt = live.utt;
    if (utt.stopped) return;
    utt.text = text;
    const busy = live.speaking.size > 0 || live.reply !== null;
    if (busy && isStopRequest(text, live.wake)) {
      utt.stopped = true;
      this.#bargeIn(live, "partial");
      return;
    }
    this.#overlap(live, utt, text, "partial");
    if (utt.wake || isStopCall(text, live.wake) || !isWakeCall(text, live.wake)) return;
    utt.wake = true;
  }

  /** The bot decided the utterance ended (0.3 s of silence): a call seen in its partials gets the "네," now. */
  #onEndpoint(live: Live, d: Record<string, unknown>): void {
    const seq = typeof d.seq === "number" && Number.isFinite(d.seq) ? Math.floor(d.seq) : null;
    const utt = live.utt;
    live.utt = newUtterance();
    this.#dropClosing(live);
    live.closing = { seq, utt };
    this.#endpointed(live);
    if (live.leaving) return;
    this.#heardSpeech(live);
    const speaker = typeof d.speaker === "string" && d.speaker.trim() ? d.speaker.trim().slice(0, 80) : null;
    // the same speaker going on with a turn that already has its "네,": no second one
    const covered = !!live.turn?.utt.ack && sameSpeaker(live.turn.speaker, speaker);
    // "모시야 나가도 돼": the goodbye line answers it, not a "네," first
    if (utt.wake && !utt.stopped && !utt.ack && !covered && !isLeaveCall(utt.text, live.wake) && this.#canAnswer(live)) this.#sendAck(live, utt, "endpoint");
    // conversation mode: ask who the line is for now, on its last partial; the transcript (~0.3 s later) reuses the
    // verdict when its words and speaker are the same
    else if (
      live.mode === "conversation" &&
      !utt.wake &&
      !utt.stopped &&
      utt.text &&
      !isFiller(utt.text) &&
      !addressesOthers(utt.text, live.agent) &&
      !live.turn &&
      this.#canAnswer(live)
    ) {
      utt.verdictText = utt.text;
      utt.verdictSpeaker = speaker;
      utt.verdict = this.#classify(live, utt.text, utt.verdictSpeaker);
    }
  }

  /** an endpoint whose transcript never came (no final text): a "네," it got is left without an answer */
  #dropClosing(live: Live): void {
    if (live.closing?.utt.ack) this.#core.log.info("meet ack without transcript", { session: live.sessionId, seq: live.closing.seq });
    live.closing = null;
  }

  #sendAck(live: Live, utt: Utterance, on: "endpoint" | "transcript"): void {
    utt.ackAt = performance.now();
    utt.ackOn = on;
    utt.ack = this.#ack(live);
    this.#core.track(utt.ack);
  }

  /** a new call replaces the answer being generated or spoken, then "네," */
  async #ack(live: Live): Promise<string | null> {
    live.reply?.abort();
    live.reply = null;
    if (live.speaking.size) await this.#bot("POST", `/sessions/${encodeURIComponent(live.sessionId)}/say/stop`, {});
    return this.#say(live, MEET_ACKS.yes, { cached: true, record: false });
  }

  #bargeIn(live: Live, on: "partial" | "final"): void {
    this.#core.log.info("meet barge-in", { session: live.sessionId, on });
    this.#dropTurn(live); // "모시 그만" also ends a turn that was waiting for more
    live.reply?.abort();
    live.reply = null;
    void this.#bot("POST", `/sessions/${encodeURIComponent(live.sessionId)}/say/stop`, {});
  }

  /** an answer can follow (model configured, quota left) — otherwise no "네," either */
  #canAnswer(live: Live): boolean {
    const llm = this.#core.deps.llm;
    return !!(llm?.meetClient || llm?.chat) && !quotaExceeded(this.#core, live.userId);
  }

  #onTranscript(live: Live, d: Record<string, unknown>): void {
    const core = this.#core;
    const seq = typeof d.seq === "number" && Number.isFinite(d.seq) ? Math.floor(d.seq) : null;
    // this final closes the utterance its endpoint handed over (or, from a bot without endpoints, the partials so far)
    let utt: Utterance;
    if (live.closing && (live.closing.seq === null || live.closing.seq === seq)) {
      utt = live.closing.utt;
      live.closing = null;
    } else {
      this.#dropClosing(live);
      utt = live.utt;
      live.utt = newUtterance();
    }
    this.#endpointed(live); // a bot without endpoints: the transcript ends the utterance
    const text = String(d.text ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
    if (seq === null || !text) return;
    const speaker = typeof d.speaker === "string" && d.speaker.trim() ? d.speaker.trim().slice(0, 80) : null;
    const now = core.now();
    const startMs = numOrNull(d.startMs);
    const endMs = numOrNull(d.endMs);
    if (isPromptEcho(text, live.sttPrompt, startMs !== null && endMs !== null ? endMs - startMs : null)) {
      // whisper returned its prompt for unclear audio: not speech, and never a call
      if (seq > live.lastSeq) live.lastSeq = seq;
      core.log.info("meet prompt echo dropped", { session: live.sessionId, seq });
      return;
    }
    const r = core.db.sql
      .query(
        `INSERT OR IGNORE INTO meet_utterances (meeting_id, seq, speaker, text, start_ms, end_ms, at, role) VALUES (?, ?, ?, ?, ?, ?, ?, 'heard')`,
      )
      .run(live.id, seq, speaker, text, startMs, endMs, now);
    if (seq > live.lastSeq) {
      live.lastSeq = seq;
      core.db.sql.query(`UPDATE meetings SET last_seq = ? WHERE id = ?`).run(seq, live.id);
    }
    if (r.changes === 0) return; // replayed after a reconnect
    live.pending.push({ speaker, text, at: now, self: false });
    if (live.leaving) return; // on its way out: written down, never answered
    this.#heardSpeech(live);
    const heard = { speaker, text, at: now };

    // "모시야 이제 나가도 돼": anyone may ask; no model needed
    if (isLeaveCall(text, live.wake)) {
      core.track(this.#leaveAsked(live, "call"));
      return;
    }
    // "모시야 이제 됐어" — also when already listening (after the idle timeout the room may not know): never a question
    const dismissCall = isDismissCall(text, live.wake);
    if (utt.stopped) {
      // barge-in already happened on a partial of this utterance; "모시야 조용히 해" also ends the conversation
      if (dismissCall) core.track(this.#dismiss(live));
      return;
    }
    const busy = live.speaking.size > 0 || live.reply !== null;
    if (busy && isStopRequest(text, live.wake)) {
      this.#dropTurn(live);
      this.#bargeIn(live, "final");
      if (dismissCall) core.track(this.#dismiss(live));
      return;
    }
    if (isStopCall(text, live.wake) || dismissCall) {
      this.#dropTurn(live);
      if (dismissCall) core.track(this.#dismiss(live));
      return;
    }
    // no partials for this utterance (local STT): C and D act on the transcript
    if (!utt.text) this.#overlap(live, utt, text, "transcript");
    const wake = isWakeCall(text, live.wake);
    if (wake && this.#canAnswer(live)) {
      live.convoFrom = now;
      this.#enterConversation(live, "wake");
    }
    const turn = live.turn;
    if (turn && sameSpeaker(turn.speaker, speaker)) {
      this.#extendTurn(live, turn, heard, utt);
      return;
    }
    if (wake) {
      // a new call (another speaker's, or the first): it replaces a turn still waiting
      const held = this.#dropTurn(live);
      if (isBareCall(text, live.wake)) this.#holdTurn(live, heard, utt, "call", true);
      // called right after a bare call: its "네," already covers this one
      else this.#take(live, heard, !utt.ack && held ? held.utt : utt, "call");
      return;
    }
    if (turn) return; // another speaker while a turn waits: never merged, it only delays the answer (above)
    if (utt.ack) core.log.info("meet partial wake revised", { session: live.sessionId, seq }); // "네," said, no answer
    if (live.mode === "conversation") core.track(this.#followUp(live, heard, utt));
  }

  // ── conversation mode ──

  /** A line without the name while in conversation mode: answered only if the addressee check says it's for 모시. */
  async #followUp(live: Live, heard: { speaker: string | null; text: string; at: number }, utt: Utterance): Promise<void> {
    if (isFiller(heard.text) || !this.#canAnswer(live)) return;
    const log = (f: Record<string, unknown>) => this.#core.log.info("meet addressee", { session: live.sessionId, ...f });
    // "민수님, …", "다들 …": to someone else, no check needed
    if (addressesOthers(heard.text, live.agent)) return log({ verdict: "other", ms: 0, backend: "rule", reused: false });
    const norm = (t: string) => t.replace(/[\s\p{P}\p{S}]+/gu, "");
    const reused = !!utt.verdict && norm(utt.verdictText) === norm(heard.text) && utt.verdictSpeaker === heard.speaker;
    const r = reused ? await utt.verdict! : await this.#classify(live, heard.text, heard.speaker);
    if (!r || live.finished || live.leaving || live.mode !== "conversation") return;
    // a leave imperative leaves unless the line is cross-talk. Rules only: a "leave" choice in the classifier cost
    // follow-ups about leaving their "addressed" (SERVER-CONTRACT.md), and these lines mostly come back "dismiss"
    if (r.verdict !== "other" && isLeaveRequest(heard.text)) {
      log({ verdict: "leave", classified: r.verdict, ms: r.ms, backend: r.backend, reused });
      return this.#leaveAsked(live, "followup");
    }
    const addressed = r.verdict === "addressed";
    // unfinished ("그럼 장소는"): no question in it yet — it waits, and the statement gate judges the whole turn
    const unfinished = addressed && this.timings.turnHoldMs > 0 && this.#unfinished(live, heard.text);
    // a statement ("그럼 수요일로 확정할게요.") is for the room even when the classifier leans "addressed"
    const statement = addressed && !unfinished && !looksLikeAsk(heard.text);
    const verdict = statement ? "other" : r.verdict;
    log({ verdict, ms: r.ms, backend: r.backend, reused, ...(statement ? { gate: "statement" } : {}), ...(unfinished ? { held: true } : {}) });
    if (verdict === "addressed") this.#take(live, heard, utt, "followup");
    else if (verdict === "dismiss") await this.#dismiss(live);
  }

  /** who the line is for (null: no classifier, or it failed — then it isn't answered) */
  async #classify(live: Live, text: string, speaker: string | null): Promise<AddresseeResult | null> {
    const core = this.#core;
    const cls = core.deps.llm?.addressee;
    if (!cls) return null;
    // the conversation since the latest call (earlier talk misleads the check), at most 3 minutes back
    const lines = this.utterances(live.id, Math.max(live.convoFrom, core.now() - WAKE_CONTEXT_MS)).slice(-7);
    if (lines.length && lines[lines.length - 1]!.role === "heard" && lines[lines.length - 1]!.text === text) lines.pop();
    const recent = lines.slice(-6).map((u) => `${u.role === "said" ? live.agent : (u.speaker ?? "참석자")}: ${u.text}`);
    try {
      const r = await cls({ utterance: text, speaker, recent, agent: live.agent }, live.ctl.signal);
      if (r.tokens > 0) core.db.addUsage(live.userId, quotaDay(core.now()), r.tokens);
      return r;
    } catch (err) {
      if (!live.ctl.signal.aborted) core.log.warn("meet addressee failed", { session: live.sessionId, err: errInfo(err) });
      return null;
    }
  }

  #enterConversation(live: Live, reason: "wake"): void {
    if (live.mode !== "conversation") {
      this.#setMode(live, "conversation", reason);
      const now = this.#core.now();
      if (now - live.modeNote.at >= this.timings.modeNoteMs) {
        live.modeNote = { shown: true, at: now };
        this.#note(live.threadId, live.userId, `${iGa(live.agent)} 대화에 들어왔어요. '이제 됐어'라고 하면 다시 듣기만 해요.`);
      }
    }
    this.#touch(live);
  }

  #leaveConversation(live: Live, reason: "dismiss" | "idle"): void {
    if (live.mode !== "conversation") return;
    this.#setMode(live, "listening", reason);
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    if (live.modeNote.shown) {
      live.modeNote.shown = false;
      this.#note(live.threadId, live.userId, "다시 듣기만 할게요.");
    }
  }

  #setMode(live: Live, to: MeetMode, reason: string): void {
    this.#core.log.info("meet mode", { session: live.sessionId, from: live.mode, to, reason });
    live.mode = to;
  }

  /** a line for 모시 (or its answer) keeps the conversation going for another conversationIdleMs */
  #touch(live: Live): void {
    if (live.mode !== "conversation" || live.finished) return;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => this.#idle(live), this.timings.conversationIdleMs);
    (live.idleTimer as { unref?: () => void }).unref?.();
  }

  #idle(live: Live): void {
    live.idleTimer = null;
    if (live.finished || live.mode !== "conversation") return;
    if (live.reply || live.speaking.size || live.turn) return this.#touch(live); // still mid-exchange
    this.#leaveConversation(live, "idle");
  }

  /** "이제 됐어": stop talking, say "네, 듣고 있을게요." (a cached clip) and listen again (already listening: just the line) */
  async #dismiss(live: Live): Promise<void> {
    if (live.finished) return;
    if (live.mode !== "conversation" && !this.#canAnswer(live)) return; // a bot that never answers doesn't confirm either
    this.#dropTurn(live);
    this.#leaveConversation(live, "dismiss");
    live.reply?.abort();
    live.reply = null;
    if (live.speaking.size) await this.#bot("POST", `/sessions/${encodeURIComponent(live.sessionId)}/say/stop`, {});
    await this.#say(live, MEET_ACKS.listening, { cached: true, record: false });
  }

  // ── turns (B): wait for the end of what the speaker is saying ──

  /** A line for 모시: a complete one is answered now, an unfinished one ("모시야 그 문서를") waits for the rest. */
  #take(live: Live, heard: { speaker: string | null; text: string; at: number }, utt: Utterance, kind: "call" | "followup"): void {
    if (this.timings.turnHoldMs > 0 && this.#unfinished(live, heard.text)) {
      this.#holdTurn(live, heard, utt, kind, false);
      return;
    }
    this.#dropTurn(live);
    this.#core.track(this.#answer(live, heard, utt, kind));
  }

  /** turnIncomplete, judged without a call at the end ("근데 모시야" → "근데"; "정리해 줘, 모시야" → "정리해 줘") */
  #unfinished(live: Live, text: string): boolean {
    const rest = text.replace(new RegExp(`(?:${live.wake.exact.source})[\\s,.!?~…]*$`), "").replace(/[\s,，、]+$/, "");
    return turnIncomplete(rest || text);
  }

  /**
   * Hold a line for 모시 until the turn ends. A bare call or an unfinished call gets its "네," now; an unfinished
   * follow-up just waits. Logs the kind only.
   */
  #holdTurn(live: Live, heard: { speaker: string | null; text: string; at: number }, utt: Utterance, kind: "call" | "followup", bare: boolean): void {
    this.#dropTurn(live);
    if (!this.#canAnswer(live)) return;
    if (kind === "call" && !utt.ack) this.#sendAck(live, utt, "transcript");
    live.turn = { speaker: heard.speaker, text: heard.text, utt, kind, bare, firstAt: performance.now(), parts: 1, timer: null };
    this.#armTurn(live);
    this.#core.log.info("meet turn held", { session: live.sessionId, kind, bare });
  }

  /**
   * The same speaker's next transcript (either side without a name counts as the same): one turn. Answered at once
   * when the whole is complete, otherwise it waits again. A bare call takes the next line as its question.
   */
  #extendTurn(live: Live, turn: PendingTurn, heard: { speaker: string | null; text: string; at: number }, utt: Utterance): void {
    if (isBareCall(heard.text, live.wake)) {
      // the name again, nothing asked: a fresh bare call (its own "네," if it has none yet)
      this.#holdTurn(live, heard, utt.ack ? utt : turn.utt, "call", true);
      return;
    }
    const wake = isWakeCall(heard.text, live.wake);
    turn.text = turn.bare && wake ? heard.text : `${turn.text} ${heard.text}`;
    turn.speaker = heard.speaker ?? turn.speaker;
    if (utt.ack) turn.utt = utt;
    if (turn.bare || wake) turn.kind = "call";
    turn.bare = false;
    turn.parts++;
    if (this.timings.turnHoldMs > 0 && this.#unfinished(live, turn.text)) {
      this.#armTurn(live);
      return;
    }
    this.#answerTurn(live, "complete");
  }

  /** (re)start the turn's wait: from now, never past firstAt + turnMaxMs */
  #armTurn(live: Live): void {
    const turn = live.turn;
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    const wait = turn.bare ? this.timings.callFollowMs : this.timings.turnHoldMs;
    const left = this.timings.turnMaxMs - (performance.now() - turn.firstAt);
    turn.timer = setTimeout(() => this.#turnDue(live), Math.max(0, Math.min(wait, left)));
    (turn.timer as { unref?: () => void }).unref?.();
  }

  /** speech (a partial, an endpoint, a transcript): a waiting turn waits on */
  #heardSpeech(live: Live): void {
    if (live.turn) this.#armTurn(live);
  }

  #turnDue(live: Live): void {
    const turn = live.turn;
    if (!turn || live.finished || live.leaving) return;
    if (turn.bare) {
      this.#dropTurn(live);
      this.#core.track(this.#callAlone(live, turn));
      return;
    }
    this.#answerTurn(live, performance.now() - turn.firstAt >= this.timings.turnMaxMs - 1 ? "cap" : "hold");
  }

  /** the turn is over: answer everything in it (a follow-up that turned out to be a statement: nothing) */
  #answerTurn(live: Live, end: "complete" | "hold" | "cap"): void {
    const turn = this.#dropTurn(live);
    if (!turn) return;
    const waitMs = Math.round(performance.now() - turn.firstAt);
    const statement = turn.kind === "followup" && !looksLikeAsk(turn.text);
    this.#core.log.info("meet turn", { session: live.sessionId, kind: turn.kind, end, parts: turn.parts, waitMs, ...(statement ? { gate: "statement" } : {}) });
    if (statement) return;
    const heard = { speaker: turn.speaker, text: turn.text, at: this.#core.now() };
    this.#core.track(this.#answer(live, heard, turn.utt, turn.kind, { firstAt: turn.firstAt, parts: turn.parts }));
  }

  /** the waiting turn, if any, no longer waiting */
  #dropTurn(live: Live): PendingTurn | null {
    const turn = live.turn;
    if (!turn) return null;
    if (turn.timer) clearTimeout(turn.timer);
    live.turn = null;
    return turn;
  }

  async #callAlone(live: Live, turn: PendingTurn): Promise<void> {
    if (live.finished || live.leaving) return;
    const acked = (await turn.utt.ack) !== null;
    await this.#clearToSpeak(live, live.ctl.signal);
    if (live.finished || live.leaving || live.turn || live.reply) return; // someone went on in the meantime
    this.#core.log.info("meet call alone", { session: live.sessionId });
    await this.#say(live, acked ? "말씀하세요." : "네, 말씀하세요.");
  }

  /**
   * A call (or, in conversation mode, a line for 모시) → the meeting agent with read-only tools (meetAgent.ts
   * runMeetTurn; without deps.llm.meetClient: one plain model call) → /say, each sentence as soon as it's complete.
   * Without a "네," yet, one goes out only if neither the first sentence nor a tool call comes within ackGraceMs; a tool
   * call plays "찾아볼게요." after a "네," or "네, 잠시만요." in its place (cached clips).
   */
  async #answer(
    live: Live,
    heard: { speaker: string | null; text: string; at: number },
    utt: Utterance = newUtterance(),
    kind: "call" | "followup" = "call",
    /** a turn that waited (B): when it was first held and how many transcripts it has */
    turn: { firstAt: number; parts: number } | null = null,
  ): Promise<void> {
    const core = this.#core;
    const chat = core.deps.llm?.chat;
    const agentLlm = core.deps.llm?.meetClient;
    if (!chat && !agentLlm) {
      core.log.warn("meet wake ignored", { reason: "no_llm" });
      return;
    }
    if (quotaExceeded(core, live.userId)) {
      core.log.warn("meet wake ignored", { reason: "quota" });
      return;
    }
    const t0 = performance.now();
    this.#touch(live);
    // a new turn replaces the answer being generated or spoken (an endpoint "네," already did that, and isn't stopped)
    live.reply?.abort();
    const ctl = new AbortController();
    live.reply = ctl;
    const answering: Answering = { ctl, heard, utt, kind, firstAt: turn?.firstAt ?? t0, parts: turn?.parts ?? 1, spoke: false, committed: false };
    live.answering = answering;
    let waitMs: number | null = null;
    let ackSent: Promise<string | null> | null = utt.ack;
    let ackOn: string = utt.ack ? (utt.ackOn ?? "endpoint") : "skipped";
    let ackMs: number | null = null;
    const ackLeadMs = utt.ack && utt.ackAt !== null ? Math.round(t0 - utt.ackAt) : null;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    let firstStarted = false;
    let spoke = false;
    let filler: string | null = null;
    // a "네," and then a model slow to its first sentence: "잠시만요." once, stallMs after the "네,"
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stalled = false;
    const armStall = (ackAt: number) => {
      if (stallTimer || stalled || this.timings.stallMs <= 0) return;
      stallTimer = setTimeout(
        () => {
          stallTimer = null;
          if (spoke || filler !== null || stalled || ctl.signal.aborted || live.reply !== ctl) return;
          stalled = true;
          core.track(this.#say(live, MEET_ACKS.hold, { cached: true, record: false }));
        },
        Math.max(0, this.timings.stallMs - (performance.now() - ackAt)),
      );
      (stallTimer as { unref?: () => void }).unref?.();
    };
    const disarmStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };
    // a turn that waited (B): its "네," may be seconds old; the silence counts from now
    if (utt.ack) armStall(turn ? Math.max(utt.ackAt ?? t0, t0) : (utt.ackAt ?? t0));
    else {
      if (live.speaking.size) await this.#bot("POST", `/sessions/${encodeURIComponent(live.sessionId)}/say/stop`, {});
      // the cached "네," — unless the first sentence is ready within ackGraceMs (its audio then comes soon enough)
      const fire = () => {
        ackTimer = null;
        if (firstStarted || ackSent || ctl.signal.aborted) return;
        const at = performance.now();
        ackOn = "transcript";
        utt.ackOn = "transcript";
        utt.ackAt = at;
        ackSent = utt.ack = this.#say(live, MEET_ACKS.yes, { cached: true, record: false }).then((id) => {
          if (id) ackMs = Math.round(performance.now() - t0);
          return id;
        });
        core.track(ackSent);
        armStall(at);
      };
      if (this.timings.ackGraceMs <= 0) fire();
      else {
        ackTimer = setTimeout(fire, this.timings.ackGraceMs);
        (ackTimer as { unref?: () => void }).unref?.();
      }
    }
    let firstMs: number | null = null;
    let sentences = 0;
    let chars = 0;
    let tokens = 0;
    let tools = 0;
    let outcome = "ok";
    try {
      const recent = this.utterances(live.id, heard.at - WAKE_CONTEXT_MS)
        .slice(-60)
        .map((u) => `${u.role === "said" ? live.agent : (u.speaker ?? "참석자")}: ${u.text}`)
        .join("\n");
      const who = heard.speaker ? `${heard.speaker}님이` : "참석자가";
      const user = [
        agentLlm ? "" : `지금: ${kstNow(core.now())} (한국 시간)`, // the agent's own prompt carries the time
        live.purpose ? `회의 목적: ${live.purpose}` : "",
        `최근 3분 회의 내용:\n${recent || "(없음)"}`,
        kind === "call" ? `방금 ${who} 부른 말: "${heard.text}"` : `방금 ${who} 너에게 이어서 한 말: "${heard.text}"`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const holdAck = () => {
        firstStarted = true;
        if (ackTimer) clearTimeout(ackTimer);
        ackTimer = null;
      };
      const speak = async (raw: string) => {
        let s = spokenText(raw);
        spoke = true;
        disarmStall();
        if (!firstStarted) holdAck();
        // "네," (or "네, 잠시만요.") was already said: not "네, 금요일이에요." again (but "네이버", "네 시" stay)
        if (sentences === 0 && ackSent && (await ackSent) !== null) s = s.replace(/^네\s*[,.!]\s*/, "");
        if (!s || ctl.signal.aborted) return;
        // never start on top of someone (D): the first sentence waits for the endpoint of speech in progress
        if (waitMs === null) {
          waitMs = await this.#clearToSpeak(live, ctl.signal);
          if (ctl.signal.aborted) return;
        }
        answering.spoke = true;
        const sayId = await this.#say(live, s);
        if (sayId !== null) {
          if (live.answerSays.size > 32) live.answerSays.clear(); // ids whose `speaking off` never came
          if (!ctl.signal.aborted) live.answerSays.add(sayId);
          sentences++;
          chars += s.length;
          firstMs ??= Math.round(performance.now() - t0);
        }
      };
      if (agentLlm) {
        const r = await runMeetTurn(core, {
          userId: live.userId,
          meetingId: live.id,
          threadId: live.threadId,
          utterance: heard.text,
          speaker: heard.speaker,
          participants: this.meeting(live.id)?.participants ?? null,
          context: user,
          ownerName: live.display,
          agentName: live.agent,
          acked: !!utt.ack,
          signal: ctl.signal,
          // a document or an approval card is on its way: the answer is no longer given up when the speaker goes on (C)
          onCommit: () => {
            answering.committed = true;
          },
          // the first tool call is about to run: a cached clip covers the wait
          onFiller: () => {
            if (ctl.signal.aborted || sentences > 0) return;
            holdAck();
            disarmStall();
            filler = ackSent ? MEET_ACKS.search : MEET_ACKS.wait;
            const p = this.#say(live, filler, { cached: true, record: false });
            if (!ackSent) {
              ackOn = "filler";
              ackSent = utt.ack = p;
            }
            return p;
          },
          onSentence: speak,
        });
        outcome = r.outcome;
        tools = r.tools.length;
        return;
      }
      let buf = "";
      const stream = chat!({
        system: replySystem(live),
        user,
        maxTokens: 200,
        temperature: 0.4,
        signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(this.timings.replyTimeoutMs)]),
        onUsage: (n) => (tokens = n),
      });
      for await (const delta of stream) {
        if (ctl.signal.aborted) break;
        buf += delta;
        let cut: number;
        while (sentences < 2 && (cut = sentenceEnd(buf)) > 0) {
          const s = buf.slice(0, cut);
          buf = buf.slice(cut);
          await speak(s);
        }
        if (sentences >= 2) break;
      }
      if (!ctl.signal.aborted && sentences < 2 && buf.trim()) await speak(buf);
      if (ctl.signal.aborted) outcome = "stopped";
    } catch (err) {
      outcome = ctl.signal.aborted ? "stopped" : "error";
      if (outcome === "error") core.log.warn("meet reply failed", { err: errInfo(err) });
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
      disarmStall();
      if (live.reply === ctl) live.reply = null;
      if (live.answering === answering) live.answering = null;
      this.#touch(live);
      if (tokens > 0) core.db.addUsage(live.userId, quotaDay(core.now()), tokens);
      core.log.info("meet reply", {
        session: live.sessionId,
        kind,
        path: agentLlm ? "agent" : "plain",
        outcome,
        tools,
        filler: filler === MEET_ACKS.search ? "search" : filler === MEET_ACKS.wait ? "wait" : null,
        stall: stalled ? 1 : 0,
        ack: ackOn,
        ackMs,
        ackLeadMs,
        firstSayMs: firstMs,
        waitMs,
        parts: answering.parts,
        sentences,
        chars,
        ms: Math.round(performance.now() - t0),
      });
    }
  }

  // ── leaving when asked (A) ──

  /**
   * "모시야 이제 나가도 돼" (or, in a conversation, a leave imperative that isn't cross-talk): stop everything, say
   * LEAVE_LINE (normal TTS, in the minutes), wait until it has played (at most leaveSayMaxMs), then leave like
   * sys_leave_meet with reason "asked". Needs no model; a goodbye that fails to play doesn't stop the leaving.
   */
  async #leaveAsked(live: Live, how: "call" | "followup"): Promise<void> {
    if (live.finished || live.leaving) return;
    const row = this.meeting(live.id);
    if (!row || row.state !== "in_call") return;
    live.leaving = "asked";
    const t0 = performance.now();
    this.#dropTurn(live);
    live.reply?.abort();
    live.reply = null;
    if (live.speaking.size) await this.#bot("POST", `/sessions/${encodeURIComponent(live.sessionId)}/say/stop`, {});
    const sayId = await this.#say(live, LEAVE_LINE).catch(() => null);
    const played = sayId !== null && sayId !== "?" ? await this.#waitPlayed(live, sayId, this.timings.leaveSayMaxMs) : false;
    this.#core.log.info("meet leave asked", { session: live.sessionId, how, said: sayId !== null, played, ms: Math.round(performance.now() - t0) });
    if (live.finished) return;
    await this.#exit(row, live, "asked");
  }

  /** the bot reported `speaking {on:false}` for this sayId (true), or `capMs` passed / the meeting finished (false) */
  #waitPlayed(live: Live, sayId: string, capMs: number): Promise<boolean> {
    if (live.played.includes(sayId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(t);
        live.playWaiters.delete(sayId);
        live.ctl.signal.removeEventListener("abort", stop);
        resolve(ok);
      };
      const stop = () => done(false);
      const t = setTimeout(stop, capMs);
      live.playWaiters.set(sayId, () => done(true));
      live.ctl.signal.addEventListener("abort", stop, { once: true });
    });
  }

  // ── overlapping speech (C, D) ──

  /**
   * Someone speaks while 모시 has an answer going. Before its first real sentence (C): 3+ syllables of real speech mean
   * the speaker is going on — the answer is given up (a "네," already said stays) and the line waits again as a turn,
   * to be joined by what comes next. While 모시 speaks an answer (D): yieldSyllables of real speech over it → it stops
   * and drops the rest; the utterance then goes on as usual. Backchannels never count. Logs counts only.
   */
  #overlap(live: Live, utt: Utterance, text: string, on: "partial" | "transcript"): void {
    if (utt.yielded) return;
    const a = live.answering;
    if (a && !a.spoke) {
      // past turnMaxMs the answer goes ahead (it still waits for the endpoint, and yields if talked over)
      if (a.committed || a.ctl.signal.aborted || performance.now() - a.firstAt >= this.timings.turnMaxMs) return;
      const n = speechSyllables(text);
      if (n < CONTINUE_SYLLABLES) return;
      a.ctl.abort(new SupersededTurn()); // runMeetTurn posts nothing from it: the next run asks again
      if (live.reply === a.ctl) live.reply = null;
      live.answering = null;
      this.#core.log.info("meet turn continued", { session: live.sessionId, on, syllables: n });
      this.#dropTurn(live);
      live.turn = { speaker: a.heard.speaker, text: a.heard.text, utt: a.utt, kind: a.kind, bare: false, firstAt: a.firstAt, parts: a.parts, timer: null };
      this.#armTurn(live);
      return;
    }
    const at = this.timings.yieldSyllables;
    if (at <= 0) return;
    const speakingAnswer = [...live.speaking].some((id) => live.answerSays.has(id)) || (!!a?.spoke && !a.ctl.signal.aborted);
    if (!speakingAnswer) return;
    const n = speechSyllables(text);
    if (n < at) return;
    utt.yielded = true;
    this.#core.log.info("meet yield", { session: live.sessionId, on, syllables: n });
    a?.ctl.abort();
    if (a && live.reply === a.ctl) live.reply = null;
    live.answerSays.clear();
    void this.#bot("POST", `/sessions/${encodeURIComponent(live.sessionId)}/say/stop`, {});
  }

  /**
   * D: someone is mid-utterance (a partial within talkOverMs and no endpoint yet) → wait for its endpoint, at most
   * talkOverMaxMs. Cached acks don't wait. Without partials (local STT) there is nothing to wait for. → ms waited.
   */
  async #clearToSpeak(live: Live, signal: AbortSignal): Promise<number> {
    const t0 = performance.now();
    if (!live.utt.text || t0 - live.partialAt > this.timings.talkOverMs || signal.aborted) return 0;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        live.endpointWaiters = live.endpointWaiters.filter((w) => w !== done);
        resolve();
      };
      const t = setTimeout(done, this.timings.talkOverMaxMs);
      signal.addEventListener("abort", done, { once: true });
      live.endpointWaiters.push(done);
    });
    return Math.round(performance.now() - t0);
  }

  /** the utterance in progress ended (its endpoint, or its transcript from a bot without endpoints) */
  #endpointed(live: Live): void {
    if (!live.endpointWaiters.length) return;
    const ws = live.endpointWaiters;
    live.endpointWaiters = [];
    for (const w of ws) w();
  }

  /** `cached`: a short stock phrase the bot can play from its cache; `record: false` keeps it out of the minutes */
  /** → the bot's sayId, or null when it didn't take the line */
  async #say(live: Live, text: string, opts: { cached?: boolean; record?: boolean } = {}): Promise<string | null> {
    const res = await this.#bot("POST", `/sessions/${encodeURIComponent(live.sessionId)}/say`, opts.cached ? { text, cached: true } : { text });
    if (!res || res.status !== 202) {
      this.#core.log.warn("meet say failed", { session: live.sessionId, status: res?.status ?? 0 });
      await res?.body?.cancel().catch(() => {});
      return null;
    }
    const body = (await res.json().catch(() => ({}))) as { sayId?: unknown };
    const sayId = typeof body.sayId === "string" && body.sayId ? body.sayId : "?";
    if (opts.record === false) return sayId;
    const now = this.#core.now();
    this.#core.db.sql
      .query(`INSERT INTO meet_utterances (meeting_id, seq, speaker, text, at, role) VALUES (?, NULL, ?, ?, ?, 'said')`)
      .run(live.id, live.agent, text, now);
    live.pending.push({ speaker: live.agent, text, at: now, self: true });
    return sayId;
  }

  #startFlushing(live: Live): void {
    if (live.flushTimer) return;
    live.flushTimer = setInterval(() => {
      this.#flush(live);
      if (!live.titled) void this.#fetchTitle(live);
    }, this.timings.flushMs);
    (live.flushTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Buffered lines → one "회의록 · 11월 12일(목) HH:MM–HH:MM" message (an assistant row; its llm_json lets later turns
   * in the thread see it). The date is there so a turn the next day doesn't read the meeting's "내일" as tomorrow.
   */
  #flush(live: Live): void {
    if (!live.pending.length) return;
    const lines = live.pending.splice(0);
    const from = hhmm(lines[0]!.at);
    const to = hhmm(lines[lines.length - 1]!.at);
    const span = `${kstDay(lines[0]!.at)} ${from === to ? from : `${from}–${to}`}`;
    const who = (l: Line) => (l.self ? live.agent : (l.speaker ?? "참석자"));
    const text = `**회의록 · ${span}**\n\n${lines.map((l) => `- ${who(l)}: ${l.text}`).join("\n")}`;
    const plain = `(회의록 ${span})\n${lines.map((l) => `${who(l)}: ${l.text}`).join("\n")}`;
    this.#post(live.threadId, live.userId, "assistant", text, [{ role: "assistant", content: plain }]);
  }

  async #finish(live: Live, state: string, reason: string): Promise<void> {
    if (live.finished) return;
    live.finished = true;
    // asked to leave: the bot's own `ended {reason:"left"}` is that leave
    if (state === "ended" && reason === "left" && live.leaving) reason = live.leaving;
    this.#dropTurn(live);
    this.#endpointed(live); // a first sentence waiting for someone to finish (the goodbye waiter ends with ctl below)
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.reply?.abort();
    live.reply = null;
    if (live.flushTimer) clearInterval(live.flushTimer);
    live.flushTimer = null;
    this.#flush(live);
    const row = this.meeting(live.id);
    if (row) this.#closeRow(row, state, reason);
    this.#live.delete(live.id);
    live.ctl.abort();
    for (const w of this.#waiters.get(live.id) ?? []) w();
    this.#waiters.delete(live.id);
    if (live.joined && !live.titled) this.#core.track(this.#fetchTitle(live));
    if (live.joined) this.#core.track(this.#summarize(live));
  }

  /** The bot reads the Meet page title while in the call (GET /sessions/:id `title?`); keep it for sys_meet_notes. */
  async #fetchTitle(live: Live): Promise<void> {
    if (live.titled || !live.sessionId) return;
    const res = await this.#bot("GET", `/sessions/${encodeURIComponent(live.sessionId)}`);
    if (!res) return;
    if (res.status === 404) {
      live.titled = true; // the bot forgot the session: nothing more to learn
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { title?: unknown };
    const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!title) return;
    live.titled = true;
    this.#core.db.sql.query(`UPDATE meetings SET title = ? WHERE id = ?`).run(title, live.id);
  }

  /** Terminal state in the DB + the thread note. */
  #closeRow(row: MeetingRow, state: string, reason: string): void {
    const core = this.#core;
    core.db.sql.query(`UPDATE meetings SET state = ?, reason = ?, ended_at = ? WHERE id = ?`).run(state, reason, core.now(), row.id);
    core.log.info("meet finished", { meeting: maskMeetCode(row.code), state, reason });
    this.#note(row.thread_id, row.user_id, meetNote(state, reason) ?? STATE_NOTES.failed!);
  }

  async #summarize(live: Live): Promise<void> {
    const core = this.#core;
    const lines = this.utterances(live.id);
    const heard = lines.filter((l) => l.role === "heard");
    if (!heard.length) {
      this.#note(live.threadId, live.userId, "받아 적은 말이 없어서 요약은 건너뛰었어요.");
      return;
    }
    const chat = core.deps.llm?.chat;
    if (!chat) {
      this.#note(live.threadId, live.userId, "요약을 만들 AI가 연결돼 있지 않아서 회의록만 남겨 둘게요.");
      return;
    }
    let transcript = lines.map((l) => `[${hhmm(l.at)}] ${l.role === "said" ? live.agent : (l.speaker ?? "참석자")}: ${l.text}`).join("\n");
    if (transcript.length > 24_000) transcript = `${transcript.slice(0, 6_000)}\n…(중략)…\n${transcript.slice(-18_000)}`;
    const t0 = performance.now();
    let tokens = 0;
    let out = "";
    try {
      for await (const d of chat({
        system: summarySystem(live),
        user: `${live.purpose ? `회의 목적: ${live.purpose}\n\n` : ""}받아쓰기:\n${transcript}`,
        maxTokens: 900,
        temperature: 0.2,
        signal: AbortSignal.timeout(90_000),
        onUsage: (n) => (tokens = n),
      })) {
        out += d;
      }
    } catch (err) {
      core.log.warn("meet summary failed", { err: errInfo(err) });
    }
    if (tokens > 0) core.db.addUsage(live.userId, quotaDay(core.now()), tokens);
    out = out.trim();
    core.log.info("meet summary", { meeting: maskMeetCode(live.code), lines: lines.length, chars: out.length, ms: Math.round(performance.now() - t0) });
    if (!out) {
      this.#note(live.threadId, live.userId, "회의 요약을 만들지 못했어요. 회의록은 위에 남아 있어요.");
      return;
    }
    const text = `**회의 요약**\n\n${out}`;
    // the model's copy says which day the meeting was ("내일", "금요일" in it are relative to that day)
    const plain = `**회의 요약** (${kstDay(heard[0]!.at)}에 한 회의)\n\n${out}`;
    this.#post(live.threadId, live.userId, "assistant", text, [{ role: "assistant", content: plain }]);
    // meeting B: the same summary under the join card, in the chat thread the join was asked from
    const origin = this.#originThread(live);
    if (origin) this.#post(origin, live.userId, "assistant", text, [{ role: "assistant", content: plain }]);
  }

  /** The thread a join was asked in, when it is still the owner's own: never a shared (friend) thread. */
  #originThread(live: Live): string | null {
    const id = this.meeting(live.id)?.origin_thread_id;
    if (!id || id === live.threadId) return null;
    const t = this.#core.db.threadFor(id, live.userId);
    if (!t || t.owner_id !== live.userId || t.kind === "friend") return null;
    const members = this.#core.db.threadMembers(id);
    return members.length === 1 && members[0] === live.userId ? id : null;
  }

  #note(threadId: string, userId: string, text: string): void {
    this.#post(threadId, userId, "event", text, null);
  }

  #post(threadId: string, userId: string, role: "event" | "assistant", text: string, llm: { role: "assistant"; content: string }[] | null): void {
    const core = this.#core;
    try {
      const mid = newId("m");
      core.db.insertMessage({
        id: mid,
        threadId,
        role,
        text,
        createdAt: core.now(),
        ...(llm ? { llm } : {}),
      });
      core.db.setUnread(threadId, userId, true);
      publishMessage(core, mid);
      publishThread(core, threadId);
    } catch (err) {
      core.log.warn("meet post failed", { err: errInfo(err) });
    }
  }
}

/** the same person, as far as the transcript says: either side without a name counts as the same */
function sameSpeaker(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function replySystem(live: Live): string {
  return [
    `너는 ${live.display}님의 AI 비서야. 이름은 "${live.agent}". 지금 ${live.display}님 대신 Google Meet 회의에 들어와 있고, 회의 참석자가 방금 너를 부르거나 너와 나누던 대화를 이어서 말을 걸었어.`,
    "대답은 그대로 소리 내어 읽혀. 규칙:",
    "- 존댓말로 1~2문장, 80자 안팎으로 짧게. 첫 문장에 바로 답을 말해.",
    "- 너는 방금 \"네,\"라고 먼저 대답했어. '네'로 시작하지 말고 바로 본론을 말해.",
    "- 마크다운, 목록, 이모지, 괄호 설명, 주소(URL)는 쓰지 마.",
    "- 회의 내용과 상식에 근거해 답하고, 모르는 건 모른다고 짧게 말해.",
    `- ${live.display}님의 개인 정보(전화번호, 계정, 비밀번호 등)는 말하지 마.`,
    `- 회의 안에서 할 수 없는 일(파일 보내기, 일정 등록 등)을 부탁받으면 회의가 끝나고 ${live.display}님께 전하겠다고 말해.`,
  ].join("\n");
}

function summarySystem(live: Live): string {
  return [
    `아래는 ${iGa(live.agent)} ${live.display}님 대신 참여한 회의의 받아쓰기예요. 자동 받아쓰기라 잘못 들은 말이 섞여 있을 수 있어요.`,
    `${live.display}님이 읽을 회의 요약을 한국어로 써 주세요. 형식:`,
    "한 줄 요약 (한 문장)",
    "",
    "**결정 사항**",
    "- …",
    "",
    "**할 일**",
    "- 담당자: 할 일 (기한)",
    "",
    "**다음 일정**",
    "- …",
    "",
    "해당하는 내용이 없으면 그 항목에 '없음'이라고 쓰세요. 받아쓰기에 없는 내용은 지어내지 마세요.",
  ].join("\n");
}

// ───────────────────────────── meeting notes (sys_meet_notes, the prompt note) ─────────────────────────────

/** sys_meet_notes keeps at most this much transcript: the start and the end, with the gap marked. */
export const NOTES_TRANSCRIPT_MAX_CHARS = 12_000;
const NOTES_HEAD_CHARS = 4_000;
const NOTES_LINE_MAX_CHARS = 600;
/** the prompt note lists meetings still running or finished within this window */
export const MEET_NOTE_WINDOW_MS = DAY_MS;

const STATE_WORDS: Record<string, string> = {
  launching: "들어가는 중",
  prejoin: "들어가는 중",
  waiting_admission: "호스트 수락 대기 중",
  in_call: "진행 중",
  ended: "끝남",
  denied: "참여 거절됨",
  blocked: "참여 막힘",
  invalid: "열 수 없는 회의",
  failed: "참여 실패",
};
const stateWord = (s: string) => STATE_WORDS[s] ?? s;

/** Korean phone numbers in digits (010-1234-5678, 02 123 4567, +82 10…); spoken digits are left as STT wrote them. */
const PHONE_RE = /(?<![\d-])(?:\+82[\s.-]?0?|0)(?:1[016789]|2|[3-6][1-5]|70)[\s.-]?\d{3,4}[\s.-]?\d{4}(?![\d-])/g;

/** Meeting text handed to the model: card/ID numbers, tokens, "비밀번호 1234" values and phone numbers masked. */
export function scrubMeetText(text: string): string {
  return scrubSecrets(text).replace(PHONE_RE, "[전화번호]");
}

/** Purpose or Meet title, else the masked code — never the full code. */
export function meetingTitle(row: Pick<MeetingRow, "title" | "purpose" | "code">): string {
  const t = (row.title ?? "").trim() || row.purpose.trim();
  return t ? scrubMeetText(t.replace(/\s+/g, " ")).slice(0, 60) : `Google Meet ${maskMeetCode(row.code)}`;
}

/** "오늘 14:05", "어제 23:50", "11월 3일 09:00" (KST) */
const WEEKDAY_KO = "월화수목금토일";

/** "11월 12일(목)" in KST */
export function kstDay(ms: number): string {
  const p = kstParts(ms);
  return `${p.month}월 ${p.day}일(${WEEKDAY_KO[p.weekday - 1]})`;
}

/**
 * "오늘 11월 12일(목) 02:30", "어제 11월 11일(수) 23:10", "11월 8일(일) 12:33": always the date and weekday — with
 * "오늘" alone the model counted "금요일" from the wrong day ("오늘 오후 3시" on a Thursday).
 */
export function kstWhen(ms: number, now: number): string {
  const day = kstDate(ms);
  const prefix = day === kstDate(now) ? "오늘 " : day === kstDate(now - DAY_MS) ? "어제 " : "";
  return `${prefix}${kstDay(ms)} ${hhmm(ms)}`;
}

/** "2026년 11월 12일(목) 14:05": now, in KST, for prompts and tool results */
export function kstNow(now: number): string {
  return `${kstParts(now).year}년 ${kstDay(now)} ${hhmm(now)}`;
}

/** "[hh:mm] speaker: text" lines; past `max` chars the middle goes, marked with how many lines and which minutes. */
export function capTranscript(lines: { at: number; text: string }[], max = NOTES_TRANSCRIPT_MAX_CHARS, headMax = NOTES_HEAD_CHARS): { text: string; omitted: number } {
  const total = lines.reduce((n, l) => n + l.text.length + 1, 0);
  if (total <= max) return { text: lines.map((l) => l.text).join("\n"), omitted: 0 };
  let head = 0;
  let headLen = 0;
  while (head < lines.length && headLen + lines[head]!.text.length + 1 <= headMax) headLen += lines[head++]!.text.length + 1;
  const tailMax = max - headLen - 60; // room for the gap marker
  let tail = lines.length;
  let tailLen = 0;
  while (tail > head && tailLen + lines[tail - 1]!.text.length + 1 <= tailMax) tailLen += lines[--tail]!.text.length + 1;
  const gap = lines.slice(head, tail);
  if (!gap.length) return { text: lines.map((l) => l.text).join("\n"), omitted: 0 };
  const span = hhmm(gap[0]!.at) === hhmm(gap[gap.length - 1]!.at) ? hhmm(gap[0]!.at) : `${hhmm(gap[0]!.at)}–${hhmm(gap[gap.length - 1]!.at)}`;
  const marker = `…(중략: ${gap.length}줄, ${span})…`;
  return {
    text: [...lines.slice(0, head).map((l) => l.text), marker, ...lines.slice(tail).map((l) => l.text)].join("\n"),
    omitted: gap.length,
  };
}

interface NotesArgs {
  meeting?: string;
  part?: "summary" | "transcript" | "both";
}

/**
 * sys_meet_notes: one meeting's summary and/or transcript, plus the recent meetings to pick from. Owner only. With no
 * meeting (or "latest"), a '회의 참여' thread reads its own meeting; elsewhere the newest meeting with notes.
 */
export function meetingNotes(core: Core, userId: string, args: NotesArgs | undefined, threadId?: string): ToolResult {
  const hub = core.meet;
  const now = core.now();
  const recent = hub.recent(userId, 5);
  const brief = (r: MeetingRow) => ({
    id: r.id,
    title: meetingTitle(r),
    state: stateWord(r.state),
    started: kstWhen(r.started_at, now),
    lines: hub.lineCount(r.id),
    summary: hub.summaryText(r) !== null,
  });
  if (!recent.length) {
    return { ok: false, summary: "아직 참여한 회의가 없어요", data: { error: "no_meetings", hint: "모시가 참여한 회의가 없다고 짧게 말하세요." } };
  }
  const want = String(args?.meeting ?? "").trim();
  let row: MeetingRow | null;
  if (!want || want === "latest") row = (threadId ? hub.byThread(userId, threadId) : null) ?? hub.latest(userId);
  else {
    const m = hub.meeting(want);
    row = m && m.user_id === userId ? m : null;
  }
  if (!row) {
    return {
      ok: false,
      summary: "그 회의를 찾지 못했어요",
      data: { error: "unknown_meeting", recent: recent.map(brief), hint: "recent의 id 중 하나로 다시 부르거나 meeting을 비워 가장 최근 회의를 보세요." },
    };
  }
  const part = args?.part === "summary" || args?.part === "transcript" ? args.part : "both";
  const user = core.db.userById(userId);
  const agent = user?.agent_name ?? "모시";
  const utterances = hub.utterances(row.id);
  const summary = hub.summaryText(row);
  const title = meetingTitle(row);
  const meeting: Record<string, unknown> = {
    id: row.id,
    title,
    ...(row.title && row.purpose ? { purpose: scrubMeetText(row.purpose).slice(0, 200) } : {}),
    state: stateWord(row.state),
    started: kstWhen(row.started_at, now),
    ...(row.joined_at ? { joined: kstWhen(row.joined_at, now) } : {}),
    ...(row.ended_at ? { ended: kstWhen(row.ended_at, now) } : {}),
    ...(row.participants !== null ? { participants: row.participants } : {}),
    lines: utterances.length,
    hasSummary: summary !== null,
  };
  const data: Record<string, unknown> = { now: `${kstNow(now)} (한국 시간)`, meeting };
  const notes: string[] = [];
  if (isActive(row.state)) notes.push("아직 진행 중인 회의라 지금까지 받아 적은 내용만 있어요. 요약은 회의가 끝나면 '회의 참여' 대화방에 올라가요.");
  if (part !== "transcript") {
    if (summary) data.summary = scrubMeetText(summary);
    else if (!isActive(row.state) && utterances.length) notes.push("이 회의는 요약이 없어서 받아쓰기를 함께 줘요.");
  }
  if (part !== "summary" || !summary) {
    const lines = utterances.map((u) => {
      const who = u.role === "said" ? agent : (u.speaker ?? "참석자");
      const text = scrubMeetText(u.text.replace(/\s+/g, " ").trim()).slice(0, NOTES_LINE_MAX_CHARS);
      return { at: u.at, text: `[${hhmm(u.at)}] ${scrubMeetText(who).slice(0, 40)}: ${text}` };
    });
    if (lines.length) {
      const capped = capTranscript(lines);
      data.transcript = capped.text;
      if (capped.omitted) notes.push(`받아쓰기가 길어서 가운데 ${capped.omitted}줄을 줄였어요(앞부분과 뒷부분은 그대로).`);
    } else if (!summary) {
      notes.push(row.joined_at ? "받아 적은 말이 없어요." : `회의에 들어가지 못해서(${stateWord(row.state)}) 받아 적은 내용이 없어요.`);
    }
  }
  if (notes.length) data.note = notes.join(" ");
  data.recent = recent.map(brief);
  data.hint = [
    "자동 받아쓰기라 잘못 들은 말이 섞여 있을 수 있어요. 여기 없는 내용은 지어내지 마세요.",
    `회의에서 나온 '오늘', '내일', '금요일' 같은 말은 회의한 날(${kstDay(row.joined_at ?? row.started_at)}) 기준이에요. 날짜를 말할 때는 지금(now) 기준으로 바꿔서 날짜와 요일을 함께 말하세요.`,
    "사용자가 문서·회의록으로 만들어 달라고 했다면 이 내용으로 sys_create_artifact(kind: document)를 부르세요.",
  ].join(" ");
  return {
    ok: true,
    summary: `'${title}' 회의 내용 (${utterances.length}줄${summary ? ", 요약 있음" : ""})`,
    data,
  };
}

/**
 * "# 회의" block appended to the system prompt in the user's own threads once they have a meeting: one line per meeting
 * still running or finished in the last 24 h, then the rule that meeting content comes from sys_meet_notes (the
 * sys_join_meet result in a thread's history only shows the moment the join started).
 */
export function meetPromptNote(core: Core, userId: string, threadId?: string): string {
  try {
    return promptNote(core, userId, threadId);
  } catch (err) {
    core.log.warn("meet prompt note failed", { err: errInfo(err) }); // never blocks a turn
    return "";
  }
}

function promptNote(core: Core, userId: string, threadId: string | undefined): string {
  const hub = core.meet;
  if (!hub.hasMeetings(userId)) return "";
  const now = core.now();
  const here = threadId ? hub.byThread(userId, threadId) : null;
  const rows = hub
    .recent(userId, 5)
    .filter((r) => r.id !== here?.id && (isActive(r.state) || (r.ended_at ?? r.started_at) >= now - MEET_NOTE_WINDOW_MS))
    .slice(0, 3);
  if (here) rows.unshift(here);
  const lines = rows.map((r) => {
    const title = meetingTitle(r).replace(/'/g, "’");
    const n = hub.lineCount(r.id);
    if (isActive(r.state)) {
      return `- 회의 '${title}' ${stateWord(r.state)} (${kstWhen(r.joined_at ?? r.started_at, now)} ${r.joined_at ? "참여" : "시작"})${n ? ` · ${n}줄` : ""} → 지금까지 내용은 sys_meet_notes`;
    }
    const when = kstWhen(r.ended_at ?? r.started_at, now);
    if (!r.joined_at) return `- 회의 '${title}' ${stateWord(r.state)} ${when}`;
    const sum = hub.summaryText(r) !== null ? "요약 있음" : "요약 없음";
    return `- 회의 '${title}' ${stateWord(r.state)} ${when} · ${n}줄 · ${sum} → 내용은 sys_meet_notes`;
  });
  const thisThread = here
    ? [
        `- 지금 대화방은 위 첫 번째 회의('${meetingTitle(here).replace(/'/g, "’")}')의 '회의 참여' 대화방이에요. 대화 기록에 보이는 회의록 메시지는 최근 것 몇 개뿐이라 회의 앞부분이 빠져 있어요. 이 회의에 대해 물으면(위에 요약 메시지가 보여도) 대화 기록만 보고 답하지 말고, 답을 쓰기 전에 먼저 sys_meet_notes를 불러요(meeting을 비우면 이 회의). 문서로 만들 때도 sys_meet_notes 결과로 만들어요.`,
      ]
    : [];
  return [
    "# 회의 (모시가 대신 참여한 Google Meet · 지금 상태)",
    `- 지금: ${kstNow(now)} (한국 시간). 회의에서 나온 '금요일', '다음 주' 같은 날은 이 날짜를 기준으로 셈해요.`,
    ...lines,
    ...thisThread,
    "- 회의 내용(회의록, 요약, 정리, 문서로, 누가 뭐라고 했는지, 정한 것, 회의에서 잡은 일정·다음 회의·마감)을 물으면 먼저 sys_meet_notes로 확인하고 그 결과로 답해요. '회의 참여' 대화방에서도 마찬가지예요: 대화 기록에는 최근 회의록 몇 개만 남아서 앞부분이 빠져 있을 수 있어요. 문서로 만들어 달라고 하면 sys_meet_notes 결과로 sys_create_artifact를 불러요.",
    "- 회의는 메신저 도구(msg_*)로 볼 수 없어요. 대화 기록에 남은 sys_join_meet 결과는 참여를 시작한 순간의 상태라서 지금 상태는 위 줄과 sys_meet_notes를 따라요. 도구 이름은 답에 쓰지 않아요.",
  ].join("\n");
}

// ───────────────────────────── tools ─────────────────────────────

interface JoinArgs {
  url: string;
  purpose?: string;
}

export function joinMeetTool(core: Core): ToolDef<JoinArgs> {
  return {
    name: "sys_join_meet",
    description:
      "Join a Google Meet meeting on the user's behalf through 모시's browser bot: it listens, transcribes, answers when called by name, and posts minutes and a summary to a '회의 참여' thread. Use when the user asks you to join/attend/take notes in a Google Meet (\"이 회의 들어가서 받아 적어 줘\"). `url` is a meet.google.com link or a code like abc-defg-hij. Call it directly: the app shows the user a confirmation card and joins only after they approve, so never ask for confirmation in chat first. The host still has to admit the bot.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Google Meet link (https://meet.google.com/abc-defg-hij) or meeting code" },
        purpose: { type: "string", description: "Why the user wants you there, e.g. '주간 회의 받아 적기' (optional, Korean)" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    icon: "people",
    title: () => "회의 참여",
    approval: (a, ctx) => {
      const p = parseMeetUrl(a?.url);
      const purpose = String(a?.purpose ?? "").trim().slice(0, 200);
      return {
        // title/detail are kept (history, logs): masked; the full code travels only in `meet`, to the owner's card
        title: p ? `Google Meet 회의(${maskMeetCode(p.code)})에 참여할까요?` : "Google Meet 회의에 참여할까요?",
        detail: `${iGa(ctx?.agentName || "모시")} 이 회의에 참여해 듣고 받아 적어요. 참석자들에게는 AI 비서라고 먼저 알려요.${purpose ? `\n목적: ${purpose}` : ""}`,
        ...(p ? { meet: { code: p.code } } : {}),
      };
    },
    run: (a, ctx) => core.meet.join(ctx, a?.url, a?.purpose),
  };
}

export function meetSayTool(core: Core): ToolDef<{ text: string }> {
  return {
    name: "sys_meet_say",
    description:
      "Say something out loud in the Google Meet meeting you are attending for the user (e.g. \"회의에서 5분 늦는다고 전해 줘\"). Write exactly the Korean sentence(s) to speak, short, no markdown. Only available while a meeting is in progress.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "What to say in the meeting, in Korean, at most 600 characters" } },
      required: ["text"],
      additionalProperties: false,
    },
    icon: "speaker",
    title: () => "회의에서 말하기",
    run: (a, ctx) => core.meet.say(ctx.userId, a?.text),
  };
}

export function leaveMeetTool(core: Core): ToolDef<Record<string, never>> {
  return {
    name: "sys_leave_meet",
    description: "Leave the Google Meet meeting you are attending for the user. The summary is posted to the meeting thread afterwards.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    icon: "close",
    title: () => "회의에서 나가기",
    run: (_a, ctx) => core.meet.leave(ctx.userId),
  };
}

export function meetNotesTool(core: Core): ToolDef<NotesArgs> {
  return {
    name: "sys_meet_notes",
    description:
      "Read a Google Meet meeting that 모시 attended for the user: title, state, times (KST), the end summary and the transcript (\"[hh:mm] speaker: text\"), plus the 5 most recent meetings. Call it FIRST whenever the user asks about a meeting's content — 회의록, 회의 요약, 회의 정리, 문서로 만들어 줘, 누가 뭐라고 했어, 회의에서 정한 것 — in any thread, including the meeting's own '회의 참여' thread (its history keeps only the latest minute notes, so the start of the meeting is missing there), also while the meeting is still running. To make a document, call sys_create_artifact with what this returns. Meetings are not in the messengers: never use msg_* tools for them.",
    parameters: {
      type: "object",
      properties: {
        meeting: {
          type: "string",
          description: "a meeting id from `recent`, or \"latest\" (default): in a '회의 참여' thread its own meeting, elsewhere the newest meeting with notes",
        },
        part: { type: "string", enum: ["summary", "transcript", "both"], description: "default both; summary falls back to the transcript when there is none" },
      },
      additionalProperties: false,
    },
    icon: "doc",
    title: () => "회의 내용 보기",
    run: async (a, ctx) => meetingNotes(core, ctx.userId, a, ctx.threadId),
  };
}

/** For buildTools: join always; notes once `userId` has any meeting; say/leave only while one is in progress. */
export function meetTools(core: Core, userId: string | undefined): ToolDef[] {
  const out = [joinMeetTool(core) as unknown as ToolDef];
  if (userId && core.meet.hasMeetings(userId)) out.push(meetNotesTool(core) as unknown as ToolDef);
  if (userId && core.meet.active(userId)) out.push(meetSayTool(core) as unknown as ToolDef, leaveMeetTool(core) as unknown as ToolDef);
  return out;
}
