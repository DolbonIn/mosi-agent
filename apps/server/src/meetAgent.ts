/**
 * A meeting answer with tools: a wake-word call in a Google Meet → the same agent runner as chat turns (@pickle/agent
 * createRunTurn) on the meeting model with hidden reasoning off, a read-only tool set and spoken-style rules → spoken
 * sentences streamed to the bot's `/say` (through `onSentence`) plus, when there is more than fits in speech, one
 * message in the meeting thread ("회의 참여").
 *
 *  - Tools: every k_* except write tools, sys_time, sys_recall, sys_schedule_list, sys_web_fetch, sys_create_artifact,
 *    msg_connections, msg_list_chats, msg_read and a sys_meet_notes bound to THIS meeting. Nothing that sends or acts
 *    for the user runs from a meeting: msg_send, sys_phone_call, sys_call_me, sys_friend_message and
 *    sys_schedule_create/delete are replaced by stand-ins that only post the normal approval card to the meeting thread
 *    (owner or 1:1 only); a tool marked `write` (a k-skill that issues, sends, buys or reserves upstream), the meeting
 *    tools (join/leave/say), sys_remember and anything else are not offered at all.
 *  - k-skill logins (docs/architecture/KSKILL-CONNECTIONS.md "Meetings"): a read tool with `connection` keeps it, so
 *    the runner resolves the owner's own login as in chat; a meeting turn never waits for one (connectionWaitMs 0):
 *    with no login the `connection_request` card goes to the meeting thread and the model says so in one sentence.
 *  - Privacy: the owner's messenger contents, schedules, memories and anything read with the owner's own k-skill login
 *    (a tool with `connection` unless marked `private: false`, or marked `private`: holdings, ad performance,
 *    invoices) are spoken only in a 1:1
 *    (≤ 2 participants, the bot included) or when the caller is the owner (fuzzy name match). Otherwise the tool still
 *    runs, the room hears one fixed line, and everything the model writes afterwards goes to the thread instead.
 *    Phone numbers, e-mail addresses and secret-looking values are masked in every spoken line.
 *  - Latency: `onFiller` fires once, when the first tool call starts (before the tool runs) unless a sentence was
 *    already spoken; independent calls run in parallel (the runner does that); 8 s per tool, 15 s for the turn, then
 *    a short spoken fallback; `signal` (barge-in, a new call, "모시 그만", a yield, a dismiss, leaving) stops everything,
 *    including queued sentences. A stopped turn still posts what it left behind: a document's card, an approval card,
 *    the detail when the answer was already written. A superseded turn (abort reason `SupersededTurn`: the speaker went
 *    on, and meet.ts runs the turn again with the joined words) posts nothing, so the next run doesn't post it twice.
 *  - `onCommit` fires when a tool with an outside effect starts (sys_create_artifact, a proposal stand-in): meet.ts then
 *    no longer supersedes the turn just because the speaker goes on.
 *  - Logs: timings, tool names, counts and outcomes only — never the utterance, tool results or participant names.
 */
import type { AgentEvent, Card, ToolActivity } from "@pickle/protocol";
import {
  billableTokens,
  createRunTurn,
  estimateTokens,
  formatKst,
  partialOutcome,
  type ApprovalSpec,
  type ConnectionResolver,
  type LlmClient,
  type LlmMessage,
  type LlmToolCall,
  type RunTurn,
  type ToolContext,
  type ToolDef,
  type ToolResult,
  type TurnOutcome,
} from "@pickle/agent";
import type { Core } from "./core.ts";
import { publishMessage, publishThread, quotaExceeded, settingsOf } from "./core.ts";
import { quotaDay } from "./kst.ts";
import { errInfo } from "./log.ts";
import { meetingNotes, scrubMeetText, sentenceEnd, spokenText } from "./meet.ts";
import { phoneTools } from "./phone.ts";
import { makeToolStore } from "./toolstore.ts";
import { APPROVAL_TTL_MS } from "./turns.ts";
import { josa, newId } from "./util.ts";

// ───────────────────────────── limits ─────────────────────────────

export const MEET_TOOL_TIMEOUT_MS = 8_000;
export const MEET_TURN_TIMEOUT_MS = 15_000;
/** model steps per meeting answer (tool rounds + the answer) */
export const MEET_MAX_STEPS = 4;
/** spoken sentences: without tools / after tools */
export const MEET_MAX_SENTENCES = 2;
export const MEET_MAX_SENTENCES_TOOLS = 3;
/** the detail message posted to the meeting thread */
const DETAIL_MAX_CHARS = 6_000;

export const FALLBACK_TIMEOUT = "확인이 너무 늦어져서 지금은 답을 못 드려요. 잠시 후 다시 불러 주세요.";
export const FALLBACK_ERROR = "지금은 답을 가져오지 못했어요. 잠시 후 다시 불러 주세요.";
export const PRIVATE_LINE = "개인 정보라서 회의에서는 말씀드리지 않고, 회의 참여 대화방에 올려 둘게요.";
export const ACTION_REDIRECT = "그건 회의 중에는 바로 할 수 없어요. 회의가 끝나고 앱에서 부탁해 주세요.";
/** "확인 카드를 앱에 올렸어요", "카드로 올려 둘게요", "앱에서 확인해 주시면 진행할게요" — but not "교통카드 충전 방법" */
const CARD_CLAIM = /(?:확인|승인)\s*카드|카드(?:를|로)\s.{0,24}?(?:올려|올렸|올라|띄워|띄웠|남겨|남겼)|앱에서\s*(?:확인|승인)(?:해|하셔)\s*주시면/;

// ───────────────────────────── tool policy ─────────────────────────────

/** Read-only tools a meeting may use (plus every k_*). sys_meet_notes is replaced by one bound to the meeting. */
export const MEET_READ_TOOLS: ReadonlySet<string> = new Set([
  "sys_time",
  "sys_recall",
  "sys_schedule_list",
  "sys_web_fetch",
  "sys_create_artifact",
  "msg_connections",
  "msg_list_chats",
  "msg_read",
]);

/** Acting tools: never run from a meeting; their stand-ins only post an approval card to the meeting thread. */
export const MEET_PROPOSAL_TOOLS: ReadonlySet<string> = new Set([
  "msg_send",
  "sys_phone_call",
  "sys_call_me",
  "sys_friend_message",
  "sys_schedule_create",
  "sys_schedule_delete",
]);

/** Tools whose run leaves something behind (a document, an approval card): `onCommit` fires when one starts. */
const COMMIT_TOOLS: ReadonlySet<string> = new Set(["sys_create_artifact", ...MEET_PROPOSAL_TOOLS]);

/**
 * The abort reason meet.ts gives a turn it runs again with more words (the speaker went on): nothing from the old run
 * is posted. Any other abort reason is a stop, which still posts what the turn left behind.
 */
export class SupersededTurn extends Error {
  constructor() {
    super("superseded by the speaker going on");
    this.name = "SupersededTurn";
  }
}
const isSuperseded = (signal: AbortSignal | undefined) => !!signal?.aborted && signal.reason instanceof SupersededTurn;

/** The owner's private data: spoken only in a 1:1 or to the owner (so is every k-skill login tool: isMeetPrivateTool). */
export const MEET_PRIVATE_TOOLS: ReadonlySet<string> = new Set(["sys_recall", "sys_schedule_list", "msg_connections", "msg_list_chats", "msg_read"]);

/** An acting tool (`write`: issues, sends, buys, reserves): never offered in a meeting, whatever its name, not even as a stand-in. */
export const isWriteTool = (def: ToolDef): boolean => !!def.write;

/** A read tool a meeting may offer: every k_* plus MEET_READ_TOOLS, never a write tool. */
export const isMeetReadTool = (def: ToolDef): boolean => !isWriteTool(def) && (def.name.startsWith("k_") || MEET_READ_TOOLS.has(def.name));

/**
 * The owner's private data: MEET_PRIVATE_TOOLS, every tool @pickle/skills marks `private: true` (its SkillTool field,
 * read structurally), and every tool that runs with the owner's own k-skill login (토스증권 holdings, 네이버 검색광고
 * performance, 팝빌 lookups) unless it opts out with `private: false` (public data fetched with the owner's key: quotes,
 * keyword volume, product or paper search). A login tool that forgets the flag stays private.
 */
export const isMeetPrivateTool = (def: ToolDef): boolean => {
  const flag = (def as ToolDef & { private?: unknown }).private;
  return MEET_PRIVATE_TOOLS.has(def.name) || flag === true || (!!def.connection && flag !== false);
};

// ───────────────────────────── names / privacy ─────────────────────────────

/** "이하늘 (Haneul)", "하늘님", " 하늘 " → "이하늘", "하늘", "하늘" (lower-case, no spaces) */
/** "이하늘 (Haneul)", "하늘님", "Haneul  Lee" → ["이하늘"], ["하늘"], ["haneul", "lee"] */
function nameWords(s: string): string[] {
  return s
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .trim()
    .replace(/\s*(님|씨)$/, "")
    .toLowerCase()
    .split(/[\s,.·]+/)
    .filter(Boolean);
}

const HANGUL_NAME = /^[가-힣]+$/;

/**
 * Whether the caller looks like the owner. Meet shows the account's full name ("이하늘") while the profile may hold the
 * given name ("하늘") or the reverse: in Hangul one name may be the other plus a 1–2 syllable family name in front; in
 * Latin script every word of the shorter name must be a whole word of the longer ("Haneul" ↔ "Haneul Lee", but not
 * "Ian Kim" ↔ "Brian Kim"). No speaker → false.
 */
export function isOwnerSpeaker(speaker: string | null | undefined, ownerNames: (string | null | undefined)[]): boolean {
  const sw = nameWords(String(speaker ?? ""));
  if (!sw.length) return false;
  for (const raw of ownerNames) {
    const ow = nameWords(String(raw ?? ""));
    if (!ow.length) continue;
    const a = sw.join("");
    const b = ow.join("");
    if (a === b) return true;
    if (HANGUL_NAME.test(a) && HANGUL_NAME.test(b)) {
      const [long, short] = a.length >= b.length ? [a, b] : [b, a];
      if (short.length >= 2 && long.endsWith(short) && long.length - short.length <= 2) return true;
      continue;
    }
    const [longW, shortW] = sw.length >= ow.length ? [sw, ow] : [ow, sw];
    if (longW.length > shortW.length && shortW.every((w) => w.length >= 2 && longW.includes(w))) return true;
  }
  return false;
}

/** Private data may be spoken: a 1:1 with the bot (≤ 2 participants) or the owner asking. Unknown count = a group. */
export function privateSpeechAllowed(participants: number | null | undefined, ownerSpeaking: boolean): boolean {
  return ownerSpeaking || (typeof participants === "number" && participants > 0 && participants <= 2);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** What may be said out loud: spokenText (no markdown/URLs/emoji) with phone numbers, e-mails and secrets masked. */
export function speechSafe(text: string, max = 300): string {
  const masked = scrubMeetText(spokenText(text, max * 2))
    .replace(EMAIL_RE, "이메일 주소")
    .replace(/\[전화번호\]/g, "전화번호")
    .replace(/\[가림\]/g, "가린 정보");
  return spokenText(masked, max);
}

/** The line the model writes before details for the thread; lenient about brackets and case. */
const DETAIL_MARK = /\[\[?\s*(?:앱|app)\s*\]\]?/i;
/** text that is clearly not speech: a URL or two list lines */
const looksLikeDetail = (t: string) => /https?:\/\//.test(t) || (t.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm)?.length ?? 0) >= 2;

// ───────────────────────────── prompt ─────────────────────────────

/** Stable per user (cached prefix: tools + this); everything per turn goes into the user message. */
export function meetAgentSystem(owner: string, agent: string): string {
  return [
    `너는 ${owner}님의 AI 비서 "${agent}"야. 지금 ${owner}님 대신 Google Meet 회의에 들어와 있고, 참석자가 방금 너를 부르거나 너와 나누던 대화를 이어서 말을 걸었어. 네 대답은 그대로 소리 내어 읽혀.`,
    "",
    "# 말하는 규칙",
    "- 해요체 존댓말. 도구 없이 답하면 1~2문장, 도구를 썼으면 많아야 3문장. 첫 문장에 바로 답을 말해.",
    "- 숫자는 듣기 좋게 말해: 소수점은 반올림하고(12.6도 → 13도), 큰 수는 '7만 1천 3백 원'처럼 말해.",
    "- 마크다운, 목록, 이모지, 주소(URL), 괄호 설명은 말하는 문장에 쓰지 마.",
    "- 확실하지 않거나 확인하지 못한 건 그렇다고 짧게 말해. 지어내지 마.",
    "- 전화번호, 이메일 주소, 비밀번호, 인증번호는 절대 소리 내어 말하지 마.",
    "",
    "# 도구",
    "- 날씨, 미세먼지, 뉴스, 주가, 지하철, 장소, 지원금처럼 바뀌는 정보는 추측하지 말고 도구로 확인해. 지역을 말하지 않았으면 서울 기준으로 확인하고 서울 기준이라고 말해.",
    "- 도구를 부를 때는 그 앞에 아무 말도 쓰지 마. 서로 상관없는 도구는 한 번에 함께 불러.",
    "- 회의에서 정한 것이나 나온 얘기를 묻거나 문서로 만들어 달라고 하면 sys_meet_notes로 이 회의 내용을 보고, 문서는 sys_create_artifact로 만든 뒤 \"앱에 문서로 만들어 뒀어요\"라고 말해.",
    "- '내 일정'을 물으면 sys_schedule_list로 예약해 둔 작업을 확인해. 캘린더는 연결돼 있지 않아.",
    "- 메시지 보내기, 전화 걸기, 예약 작업 만들기·지우기, 친구에게 말 전하기를 부탁받으면 그 도구(msg_send, sys_phone_call, sys_call_me, sys_schedule_create, sys_schedule_delete, sys_friend_message)를 꼭 불러. 회의에서는 실행되지 않고 앱에 확인 카드만 올라가. 결과가 ok일 때만 앱에서 확인해 주시면 진행한다고 한 문장으로 말해.",
    "- 그 도구를 부르지 않았거나 결과가 ok가 아니면 확인 카드를 올렸다고 절대 말하지 마. 받는 사람의 전화번호처럼 꼭 필요한 정보를 모르면 도구를 부르지 말고, 회의가 끝나고 앱에서 다시 부탁해 달라고 말해.",
    `- 다른 회의 참여, 회의에서 대신 말하기는 여기서 할 수 없어. 회의에서 나가 달라는 부탁이면, '${josa(agent, "아", "야")}, 이제 나가도 돼'처럼 이름을 불러 말씀해 주시면 바로 나간다고 짧게 말해.`,
    "",
    "# 앱에 올리기",
    "- 뉴스 제목과 링크, 메시지 요약, 긴 목록처럼 말로 다 못 하는 내용은 말하는 문장을 다 쓴 뒤 줄을 바꿔 [앱] 한 줄을 쓰고, 그 아래에 마크다운으로 정리해. [앱] 아래 내용은 소리 내지 않고 회의 참여 대화방에 올라가.",
    "- 그럴 때는 말하는 문장 끝에 \"자세한 건 앱에 올려 둘게요\"처럼 짧게 알려. [앱] 표시는 말하는 문장 안에 쓰지 마.",
  ].join("\n");
}

function turnNote(o: {
  now: number;
  owner: string;
  participants: number | null;
  speaker: string | null;
  privateOk: boolean;
  connections: string[];
  acked: boolean;
}): string {
  const lines = [
    "# 지금",
    `- 현재 시각: ${formatKst(new Date(o.now))} (한국 표준시)`,
    `- 회의 참석자: ${typeof o.participants === "number" ? `${o.participants}명 (너 포함)` : "알 수 없음"}`,
    `- 부른 사람: ${o.speaker ?? "알 수 없음"}${o.privateOk ? ` (${o.owner}님 본인이거나 1:1 회의)` : ` (${o.owner}님이 아닐 수 있어요)`}`,
  ];
  if (o.privateOk) lines.push(`- 연결된 메신저: ${o.connections.length ? o.connections.join(", ") : "없음"}`);
  if (!o.privateOk) {
    lines.push(
      `- 개인 정보 규칙: 메신저 내용, 예약 작업, 기억, 연결된 계정(증권·광고·세금계산서) 정보 같은 ${o.owner}님의 개인 정보는 소리 내어 말하지 말고 [앱] 아래에만 써. 말할 때는 개인 정보라 앱에 올려 두겠다고만 해. 대신 행동하는 일은 ${o.owner}님만 부탁할 수 있어.`,
    );
  }
  if (o.acked) lines.push('- 너는 방금 "네,"라고 먼저 대답했어. "네"로 시작하지 말고 바로 본론을 말해.');
  return lines.join("\n");
}

// ───────────────────────────── the turn ─────────────────────────────

export interface MeetTurnInput {
  userId: string;
  meetingId: string;
  /** the meeting thread ("회의 참여"): details, cards and approval cards go here */
  threadId: string;
  /** the call as transcribed ("모시야 서울 날씨 어때?") */
  utterance: string;
  speaker: string | null;
  /** people in the meeting, the bot included (meetings.participants); null = unknown (treated as a group) */
  participants: number | null;
  /** what meet.ts builds: purpose + the last 3 minutes + the call. Empty → the call alone. */
  context?: string;
  /** the user's display name, for the owner check (Meet's full name vs a given name is fuzzy-matched) */
  ownerName: string;
  agentName?: string;
  /** "네," already went out: the first sentence's leading "네" is dropped */
  acked?: boolean;
  /** barge-in, a new call, a stop, a yield: nothing more is said. A `SupersededTurn` reason: nothing is posted either */
  signal?: AbortSignal;
  /** once, when a tool with an outside effect starts (sys_create_artifact, an approval stand-in) */
  onCommit?: () => void;
  /** once, when the first tool call starts and before it runs (meet.ts plays a cached "잠시만요") */
  onFiller?: () => unknown;
  /** each spoken sentence, already speech-safe; called in order, the next waits for the previous promise */
  onSentence: (text: string) => unknown;
  /** fuller result for the meeting thread; default: posted by this module as an assistant message (with cards) */
  onDetail?: (markdown: string, cards: Card[]) => unknown;
  /** tests */
  toolTimeoutMs?: number;
  turnTimeoutMs?: number;
}

export type MeetTurnOutcome = "ok" | "stopped" | "timeout" | "error" | "quota" | "no_llm";

export interface MeetTurnResult {
  outcome: MeetTurnOutcome;
  /** tool names in call order (no args) */
  tools: string[];
  sentences: number;
  /** a detail message went to the thread */
  detail: boolean;
  /** private data was kept out of speech */
  private: boolean;
  /** approval cards posted to the thread */
  proposals: number;
  tokens: number;
  timings: { fillerMs: number | null; firstToolMs: number | null; slowestToolMs: number | null; firstSentenceMs: number | null; totalMs: number; steps: number };
}

/** The meeting model's client, hidden reasoning off (main.ts → deps.llm.meetClient). */
type MeetLlm = Pick<LlmClient, "stream" | "model">;

const runners = new WeakMap<object, Map<string, RunTurn>>();
function runnerFor(client: MeetLlm, toolTimeoutMs: number): RunTurn {
  let byTimeout = runners.get(client);
  if (!byTimeout) runners.set(client, (byTimeout = new Map()));
  const key = String(toolTimeoutMs);
  let r = byTimeout.get(key);
  if (!r) {
    r = createRunTurn(client as LlmClient, { toolTimeoutMs, maxTokens: 700, temperature: 0.3 });
    byTimeout.set(key, r);
  }
  return r;
}

export interface MeetTurnState {
  core: Core;
  input: MeetTurnInput;
  owner: string;
  privateOk: boolean;
  /** a private tool returned data while private speech is not allowed */
  privateHit: boolean;
  proposals: number;
  /** cards for the thread (artifacts, credential requests) */
  cards: Card[];
}

export async function runMeetTurn(core: Core, input: MeetTurnInput): Promise<MeetTurnResult> {
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  const toolNames: string[] = [];
  const result = (outcome: MeetTurnOutcome, extra: Partial<MeetTurnResult> = {}): MeetTurnResult => ({
    outcome,
    tools: toolNames,
    sentences: 0,
    detail: false,
    private: false,
    proposals: 0,
    tokens: 0,
    timings: { fillerMs: null, firstToolMs: null, slowestToolMs: null, firstSentenceMs: null, totalMs: since(), steps: 0 },
    ...extra,
  });

  const client = core.deps.llm?.meetClient as MeetLlm | undefined;
  if (!client) {
    core.log.warn("meet agent skipped", { reason: "no_llm" });
    return result("no_llm");
  }
  if (quotaExceeded(core, input.userId)) {
    core.log.warn("meet agent skipped", { reason: "quota" });
    return result("quota");
  }

  // ── turn control: external abort (barge-in) vs the turn budget ──
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort(new DOMException("meeting turn timed out", "TimeoutError"));
  }, input.turnTimeoutMs ?? MEET_TURN_TIMEOUT_MS);
  const onExternal = () => ctl.abort(input.signal?.reason ?? new DOMException("stopped", "AbortError"));
  if (input.signal?.aborted) onExternal();
  else input.signal?.addEventListener("abort", onExternal, { once: true });
  const stopped = () => !!input.signal?.aborted;

  // ── speech: one ordered queue; nothing more is said after a barge-in ──
  let chain: Promise<unknown> = Promise.resolve();
  let sentences = 0;
  let queuedSentences = 0;
  let firstSentenceMs: number | null = null;
  let fillerMs: number | null = null;
  let firstToolMs: number | null = null;
  let slowestToolMs: number | null = null;
  /** set once the turn is over: a tool that finishes late (after a timeout) must not speak any more */
  let closed = false;
  const enqueue = (line: string) => {
    if (closed) return;
    queuedSentences++;
    chain = chain
      .then(async () => {
        if (stopped()) return;
        firstSentenceMs ??= since();
        await input.onSentence(line);
        sentences++;
      })
      .catch((err) => core.log.warn("meet agent say failed", { err: errInfo(err) }));
  };

  const user = core.db.userById(input.userId);
  const owner = (input.ownerName || user?.display_name || "사용자").trim();
  const agent = (input.agentName || user?.agent_name || "모시").trim();
  const ownerSpeaking = isOwnerSpeaker(input.speaker, [input.ownerName, user?.display_name]);
  const st: MeetTurnState = {
    core,
    input,
    owner,
    privateOk: privateSpeechAllowed(input.participants, ownerSpeaking),
    privateHit: false,
    proposals: 0,
    cards: [],
  };

  // ── text routing ──
  let speech = ""; // not yet spoken
  let detail = ""; // after the [앱] mark, or everything once private data is in play
  let inDetail = false;
  let fullText = "";
  let saidAnswer = 0; // answer sentences queued (the cap counts these)
  let privateLineSaid = false;
  /** sentences waiting for their step to finish: a confirmation-card claim made before any card exists, and what follows it */
  let held: string[] = [];
  const cap = () => (toolNames.length ? MEET_MAX_SENTENCES_TOOLS : MEET_MAX_SENTENCES);
  const cardExists = () => st.proposals > 0 || st.cards.some((c) => c.type === "credential_request" || c.type === "connection_request");
  /** answer sentences queued since the latest tool round started (the timeout fallback looks at these) */
  let saidSinceTools = 0;
  const speakNow = (s: string) => {
    if (saidAnswer >= cap()) return;
    saidAnswer++;
    saidSinceTools++;
    enqueue(s);
  };
  const say = (raw: string) => {
    if (stopped()) return;
    let s = speechSafe(raw);
    if (input.acked && saidAnswer === 0 && !held.length) s = s.replace(/^네\s*[,.!]\s*/, ""); // not "네이버", "네 시"
    if (!s) return;
    // "확인 카드를 앱에 올려 뒀어요" with no card yet: either the tool call follows in this step (then that text is dropped
    // and the answer after the tool says it) or the model made it up (then the room hears an honest redirect instead)
    if (held.length || (CARD_CLAIM.test(s) && !cardExists())) {
      held.push(s);
      return;
    }
    speakNow(s);
  };
  /** the step ended in tool calls (valid or not): a half sentence, held claim or [앱] section written before them ends there */
  const dropPreToolText = () => {
    held = [];
    speech = "";
    inDetail = false; // what went to `detail` stays
  };
  /** the last step finished: held text is spoken only if a card now really exists */
  const releaseHeld = () => {
    if (!held.length) return;
    const lines = held;
    held = [];
    if (!cardExists()) speakNow(ACTION_REDIRECT);
    else lines.forEach(speakNow);
  };
  const sayPrivateLine = () => {
    if (privateLineSaid) return;
    privateLineSaid = true;
    enqueue(PRIVATE_LINE);
  };
  const onText = (delta: string) => {
    fullText += delta;
    if (st.privateHit || inDetail) {
      detail += delta;
      return;
    }
    speech += delta;
    const m = DETAIL_MARK.exec(speech);
    if (m) {
      const before = speech.slice(0, m.index);
      detail += speech.slice(m.index + m[0].length);
      inDetail = true;
      speech = "";
      if (before.trim()) {
        let cut: number;
        let rest = before;
        while ((cut = sentenceEnd(rest)) > 0) {
          say(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        if (rest.trim()) say(rest);
      }
      return;
    }
    let cut: number;
    while ((cut = sentenceEnd(speech)) > 0) {
      const s = speech.slice(0, cut);
      speech = speech.slice(cut);
      say(s);
    }
  };
  /** private data is about to be in the model's context: what's buffered is still safe to say, nothing after it */
  const enterPrivate = () => {
    if (st.privateHit) return;
    if (speech.trim()) {
      say(speech);
      speech = "";
    }
    st.privateHit = true;
    sayPrivateLine();
  };

  const toolIds = new Set<string>();
  const emit = (e: AgentEvent) => {
    if (e.type === "tool" && !st.privateHit) dropPreToolText();
    if (e.type === "text") onText(e.delta);
    else if (e.type === "tool" && e.tool.state === "running" && !toolIds.has(e.tool.id)) {
      saidSinceTools = 0;
      toolIds.add(e.tool.id);
      toolNames.push(e.tool.name);
      firstToolMs ??= since();
      if (COMMIT_TOOLS.has(e.tool.name) && !stopped()) {
        try {
          input.onCommit?.();
        } catch (err) {
          core.log.warn("meet agent commit hook failed", { err: errInfo(err) });
        }
      }
      if (fillerMs === null && queuedSentences === 0 && !stopped()) {
        fillerMs = since();
        try {
          // started now, before the tool runs; later sentences queue behind it
          const p = input.onFiller?.();
          chain = chain.then(() => p).catch(() => {});
        } catch (err) {
          core.log.warn("meet agent filler failed", { err: errInfo(err) });
        }
      }
    } else if (e.type === "tool" && (e.tool.state === "done" || e.tool.state === "error") && e.tool.endedAt) {
      slowestToolMs = Math.max(slowestToolMs ?? 0, e.tool.endedAt - e.tool.startedAt);
    } else if (e.type === "card") {
      // things made and k-skill login requests go to the thread (never spoken); info cards (weather, results) stay out
      const card = e.card;
      if (card.type === "artifact") st.cards.push(card);
      else if (card.type === "connection_request" && !st.cards.some((c) => c.type === "connection_request" && c.service === card.service)) st.cards.push(card);
    }
  };

  // ── tools, prompt ──
  let enabled: string[] | undefined;
  try {
    const p = await core.deps.launcher.profile(input.userId);
    enabled = p?.enabledSkills?.length ? p.enabledSkills : undefined;
  } catch {
    enabled = undefined;
  }
  const memory = user ? settingsOf(user).privacy.memoryEnabled : false;
  const tools = meetToolset(core, { userId: input.userId, meetingId: input.meetingId, enabledSkills: enabled, memory }, st, enterPrivate);
  let connections: string[] = [];
  try {
    const names = new Map(core.deps.providers().map((p) => [p.id, p.name]));
    connections = (await core.deps.hub.connections(input.userId)).filter((c) => c.status === "connected").map((c) => names.get(c.provider) ?? c.provider);
  } catch {
    connections = [];
  }
  const system = meetAgentSystem(owner, agent);
  const call = input.context?.trim() ? input.context.trim() : `방금 ${input.speaker ? `${input.speaker}님이` : "참석자가"} 부른 말: "${input.utterance}"`;
  const userText = `${turnNote({ now: core.now(), owner, participants: input.participants, speaker: input.speaker, privateOk: st.privateOk, connections, acked: !!input.acked })}\n\n${scrubMeetText(call)}`;

  const ctx: ToolContext = {
    userId: input.userId,
    threadId: input.threadId,
    agentName: agent,
    displayName: owner,
    workspaceDir: core.deps.launcher.workspaceDir(input.userId),
    signal: ctl.signal,
    credentials: core.deps.vault.access(input.userId, { actor: "agent" }),
    ...connectionsOf(core, input.userId),
    store: makeToolStore(core, input.userId, input.threadId),
    mode: "voice",
    status: () => {},
    now: () => new Date(core.now()),
  };

  let outcome: MeetTurnOutcome = "ok";
  let turn: TurnOutcome | null = null;
  let failure: unknown = null;
  let runPromise: Promise<TurnOutcome> | null = null;
  let runError: unknown = null;
  try {
    const run = runnerFor(client, input.toolTimeoutMs ?? MEET_TOOL_TIMEOUT_MS);
    const aborted = new Promise<never>((_, reject) => {
      if (ctl.signal.aborted) reject(ctl.signal.reason);
      ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    // never wait for a login in a meeting: the card goes to the thread and the answer goes on (connectionWaitMs 0)
    runPromise = run({ ctx, system, history: [], userText, tools, maxSteps: MEET_MAX_STEPS, connectionWaitMs: 0 }, emit);
    runPromise.catch((e: unknown) => (runError = e)); // the race below may settle first
    turn = await Promise.race([runPromise, aborted]);
    if (!st.privateHit && !inDetail && speech.trim()) say(speech);
    speech = "";
    releaseHeld();
  } catch (err) {
    failure = err;
    outcome = stopped() ? "stopped" : timedOut ? "timeout" : "error";
    if (outcome === "error") core.log.warn("meet agent failed", { err: errInfo(err) });
    if (outcome !== "stopped" && saidSinceTools === 0 && !privateLineSaid) enqueue(outcome === "timeout" ? FALLBACK_TIMEOUT : FALLBACK_ERROR);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onExternal);
  }
  // after a barge-in / new call the caller cuts the bot itself: return at once, nothing more is spoken or awaited
  const stoppedNow = outcome === "stopped";
  // an aborted runner attaches what it already did (usage included) to its own rejection once it unwinds
  if (!turn && runPromise && !stoppedNow) await settleWithin(runPromise, 250);

  // ── details for the thread ──
  let detailText = "";
  if (outcome !== "ok" && outcome !== "stopped" && st.privateHit) {
    // the room was told it would be in the thread
    const partial = detail.replace(DETAIL_MARK, "").trim();
    detailText = partial ? `${partial}\n\n(답을 끝까지 만들지 못했어요. 앱에서 다시 물어봐 주세요.)` : "답을 만들지 못했어요. 앱에서 다시 물어봐 주세요.";
  } else if (outcome === "ok") {
    if (st.privateHit) {
      // what the model wrote after the private data came in; past its [앱] mark when it used one
      const m = DETAIL_MARK.exec(detail);
      const after = m ? detail.slice(m.index + m[0].length) : "";
      detailText = (after.trim() ? after : detail.replace(DETAIL_MARK, "")).trim();
    }
    else if (inDetail) detailText = detail.trim();
    else if (looksLikeDetail(fullText)) detailText = fullText.trim();
  }
  // a stopped turn still posts what it left behind (a document made, a login needed): stopping speech doesn't undo
  // them. A superseded one posts nothing: it runs again with the joined words and posts then.
  let posted = false;
  if ((detailText || st.cards.length) && !isSuperseded(input.signal)) {
    const heading = st.privateHit ? "**회의 중 질문 · 개인 정보라 여기에만 올려요**" : "**회의 중 질문 · 자세한 내용**";
    const asked = `> ${input.speaker ? `${scrubMeetText(input.speaker).slice(0, 40)}님: ` : ""}${scrubMeetText(input.utterance).replace(/\s+/g, " ").slice(0, 200)}`;
    const md = detailText ? `${heading}\n${asked}\n\n${detailText.slice(0, DETAIL_MAX_CHARS)}` : `**회의 중에 만든 것**\n${asked}`;
    try {
      if (input.onDetail) await input.onDetail(md, st.cards);
      else postToThread(core, input.userId, input.threadId, md, st.cards);
      posted = true;
    } catch (err) {
      core.log.warn("meet agent detail failed", { err: errInfo(err) });
    }
  }

  closed = true;
  if (!stoppedNow) await chain;

  // ── usage: what chat turns charge (cached prompt tokens at 10 %); an aborted call that produced output is estimated ──
  const account = (): number => {
    let tokens = 0;
    if (turn) tokens = billableTokens(turn.usage);
    else {
      tokens = billableTokens((partialOutcome(runError) ?? partialOutcome(failure))?.usage);
      if (!tokens && (fullText || toolNames.length)) tokens = estimateTokens(system + userText) * (1 + Math.min(toolNames.length, 3)) + estimateTokens(fullText);
    }
    if (tokens > 0) {
      try {
        core.db.addUsage(input.userId, quotaDay(core.now()), tokens);
      } catch (err) {
        core.log.warn("meet agent usage failed", { err: errInfo(err) });
      }
    }
    return tokens;
  };
  const steps = turn ? turn.messages.filter((m) => m.role === "assistant").length : 0;
  const finish = (tokens: number): MeetTurnResult => {
    const res = result(outcome, {
      sentences,
      detail: posted,
      private: st.privateHit,
      proposals: st.proposals,
      tokens,
      timings: { fillerMs, firstToolMs, slowestToolMs, firstSentenceMs, totalMs: since(), steps },
    });
    log(res, tokens);
    return res;
  };
  if (stoppedNow && !turn && runPromise) {
    // usage is known once the runner unwinds: charge (and log) it in the background
    const unwind = runPromise;
    core.track(
      settleWithin(unwind, 1_000)
        .then(() => finish(account()))
        .catch((err) => core.log.warn("meet agent usage failed", { err: errInfo(err) })),
    );
    return result(outcome, { sentences, detail: posted, private: st.privateHit, proposals: st.proposals, timings: { fillerMs, firstToolMs, slowestToolMs, firstSentenceMs, totalMs: since(), steps } });
  }
  return finish(account());

  function log(res: MeetTurnResult, tokens: number): void {
    core.log.info("meet agent", {
      meeting: input.meetingId,
      outcome,
      tools: toolNames.join(",") || null,
      steps,
      fillerMs,
      firstToolMs,
      slowestToolMs,
      firstSayMs: firstSentenceMs,
      ms: res.timings.totalMs,
      sentences,
      detail: posted ? 1 : 0,
      private: st.privateHit ? 1 : 0,
      privateOk: st.privateOk ? 1 : 0,
      proposals: st.proposals,
      usage: tokens, // (a field named "tokens" is redacted by the logger)
    });
  }
}

/** Wait for `p` to settle, at most `ms`. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p.then(() => {}, () => {}), new Promise<void>((res) => (t = setTimeout(res, ms)))]);
  clearTimeout(t);
}

// ───────────────────────────── the tool set ─────────────────────────────

/**
 * What the meeting model may call. Every def is a fresh wrapper without `approval`/`credential`, so the runner never
 * pauses a meeting turn: logins are reported back to the model (and the card goes to the thread), the listed acting
 * tools only post an approval card, `write` tools aren't offered at all (not even as a stand-in: the wrapper would drop
 * their approval), private tools (k-skill login tools included) flip the turn into "thread only" when the room may not
 * hear them. A read tool keeps `connection`/`connectionReason`, so the runner resolves the owner's login for it.
 */
export function meetToolset(
  core: Core,
  o: { userId: string; meetingId: string; enabledSkills?: string[]; memory: boolean },
  st: MeetTurnState,
  enterPrivate: () => void,
): ToolDef[] {
  const out: ToolDef[] = [];
  const seen = new Set<string>(["sys_meet_notes"]);
  if (!o.memory) seen.add("sys_recall");
  const add = (label: string, fn: () => ToolDef[]) => {
    let defs: ToolDef[] = [];
    try {
      defs = fn();
    } catch (err) {
      core.log.warn("meet agent tools unavailable", { source: label, err: errInfo(err) });
    }
    for (const d of defs) {
      if (!d || typeof d.name !== "string" || seen.has(d.name)) continue;
      if (isWriteTool(d)) continue; // 발행, 예약 요청, 구매 …: never offered in a meeting, not even as a card stand-in
      if (isMeetReadTool(d)) {
        seen.add(d.name);
        out.push(readTool(d, st, enterPrivate));
      } else if (MEET_PROPOSAL_TOOLS.has(d.name)) {
        seen.add(d.name);
        out.push(proposalTool(d, st));
      }
    }
  };
  add("system", () => core.deps.systemTools());
  add("skills", () => core.deps.skills.skillTools(o.enabledSkills));
  add("messengers", () => core.deps.hub.tools());
  add("server", () => phoneTools(core));
  out.push(currentMeetingNotesTool(core, o.meetingId));
  return out;
}

function baseOf(def: ToolDef, description = def.description): Omit<ToolDef, "run"> {
  return { name: def.name, description, parameters: def.parameters, icon: def.icon, title: (a) => def.title(a) };
}

async function credentialGate(def: ToolDef, args: Record<string, unknown>, ctx: ToolContext, st: MeetTurnState): Promise<ToolResult | null> {
  if (!def.credential) return null;
  const need = await def.credential(args, ctx);
  if (!need) return null;
  st.cards.push({ type: "credential_request", service: need.service, serviceName: need.serviceName, reason: need.reason, fields: need.fields, status: "pending" });
  return {
    ok: false,
    summary: `${need.serviceName} 연결이 필요해요`,
    data: { error: "credential_required", hint: `${need.serviceName}이(가) 아직 연결되지 않았어요. 앱의 회의 참여 대화방에 연결 카드를 올렸으니 거기서 연결해 달라고 한 문장으로 말하세요.` },
  };
}

/** the owner's k-skill logins, from the server's registry (core.connections) once it has one; none → login tools fail closed */
function connectionsOf(core: Core, userId: string): { connections?: ConnectionResolver } {
  const registry = (core as { connections?: { forUser?(userId: string): ConnectionResolver } }).connections;
  try {
    const connections = registry?.forUser?.(userId);
    return connections ? { connections } : {};
  } catch (err) {
    core.log.warn("meet agent connections unavailable", { err: errInfo(err) });
    return {};
  }
}

/** a k-skill login tool's fields, so the runner resolves `ctx.connection` (and the card) for the wrapper */
function loginOf(def: ToolDef): Pick<ToolDef, "connection" | "connectionReason"> {
  if (!def.connection) return {};
  return { connection: def.connection, ...(def.connectionReason ? { connectionReason: def.connectionReason } : {}) };
}

function readTool(def: ToolDef, st: MeetTurnState, enterPrivate: () => void): ToolDef {
  const isPrivate = isMeetPrivateTool(def);
  return {
    ...baseOf(def),
    ...loginOf(def),
    ...(isPrivate ? { private: true } : {}), // the same SkillTool marker: this wrapper's results are routed as private
    async run(args, ctx) {
      const gate = await credentialGate(def, args, ctx, st);
      if (gate) return gate;
      const r = await def.run(args, ctx);
      if (ctx.signal.aborted) return r; // past its timeout (or the turn is over): the runner already moved on
      if (isPrivate && !st.privateOk) {
        // the model still sees the data (it writes the thread message); the room only hears PRIVATE_LINE
        if (r?.ok) enterPrivate();
        // no candidates/chat names in a failure either; a login refusal (service, name, reason) still reaches the runner
        else if (r) return { ok: false, summary: r.summary, ...(r.needsConnection ? { needsConnection: r.needsConnection } : {}) };
      }
      return r;
    },
  };
}

function proposalTool(def: ToolDef, st: MeetTurnState): ToolDef {
  return {
    ...baseOf(
      def,
      `${def.description} In a meeting, calling this posts a confirmation card to the user's app instead of acting: call it whenever someone asks for this, then say the card is in the app.`,
    ),
    async run(args, ctx) {
      const { core, input } = st;
      if (!st.privateOk) {
        return {
          ok: false,
          summary: `${st.owner}님만 부탁할 수 있어요`,
          data: { error: "owner_only", hint: `이 일은 ${st.owner}님만 부탁할 수 있다고 한 문장으로 짧게 말하세요.` },
        };
      }
      const gate = await credentialGate(def, args, ctx, st);
      if (gate) return gate;
      if (st.proposals >= 1) return { ok: false, summary: "확인 카드는 한 번에 하나만 올려요", data: { error: "one_at_a_time" } };
      let spec: ApprovalSpec | null = null;
      try {
        spec = def.approval?.(args, ctx) ?? null;
      } catch {
        spec = null;
      }
      const title = (() => {
        try {
          return def.title(args);
        } catch {
          return def.name;
        }
      })();
      spec ??= { title: `${title} — 진행할까요?`, detail: "회의 중에 부탁받은 일이에요." };
      // superseded meanwhile (the speaker went on): the next run asks again, so no card from this one
      if (isSuperseded(input.signal)) return { ok: false, summary: "회의 대답이 멈췄어요", data: { error: "stopped" } };
      const call: LlmToolCall = { id: newId("call"), type: "function", function: { name: def.name, arguments: JSON.stringify(args ?? {}) } };
      const asked = `(회의 중 ${input.speaker ? `${input.speaker}님이` : "참석자가"} 부탁한 일) ${input.utterance}`.slice(0, 600);
      const prior: LlmMessage[] = [
        { role: "user", content: asked },
        { role: "assistant", content: null, tool_calls: [call] },
      ];
      postApproval(core, input.userId, input.threadId, call, spec, prior, title);
      st.proposals++;
      return {
        ok: true,
        summary: "앱에 확인 카드를 올렸어요",
        data: {
          status: "waiting_for_user",
          hint: "회의에서는 실행하지 않았어요. 앱의 회의 참여 대화방에 확인 카드를 올렸으니, 앱에서 확인해 주시면 진행한다고 한 문장으로 말하세요.",
        },
      };
    },
  };
}

/** sys_meet_notes, but always THIS meeting and without the list of the user's other meetings. */
function currentMeetingNotesTool(core: Core, meetingId: string): ToolDef {
  return {
    name: "sys_meet_notes",
    description:
      "Read what has been said in THIS meeting so far (\"[hh:mm] speaker: text\", automatic transcription). Use it when the recent lines in the prompt aren't enough: what was decided, who said what, or before making a document of the meeting with sys_create_artifact.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    icon: "doc",
    title: () => "회의 내용 보기",
    async run(_a, ctx) {
      const r = meetingNotes(core, ctx.userId, { meeting: meetingId, part: "both" });
      if (r.data && typeof r.data === "object") delete (r.data as Record<string, unknown>).recent;
      return r;
    },
  };
}

// ───────────────────────────── thread posts ─────────────────────────────

function postToThread(core: Core, userId: string, threadId: string, text: string, cards: Card[]): void {
  const id = newId("m");
  core.db.insertMessage({ id, threadId, role: "assistant", text, cards, createdAt: core.now(), llm: [{ role: "assistant", content: text }] });
  core.db.setUnread(threadId, userId, true);
  publishMessage(core, id);
  publishThread(core, threadId);
}

/**
 * The normal approval flow (as executeTurn persists it): an assistant row with the pending approval card (llm `[]`)
 * plus the approvals row. POST /api/approvals/:id then resumes a regular chat turn in the meeting thread, which runs
 * the real tool.
 */
function postApproval(core: Core, userId: string, threadId: string, call: LlmToolCall, spec: ApprovalSpec, prior: LlmMessage[], title: string): void {
  const now = core.now();
  const messageId = newId("m");
  const approvalId = newId("ap");
  const card: Card = {
    type: "approval",
    approvalId,
    title: spec.title,
    detail: spec.detail,
    ...(typeof spec.amount === "number" ? { amount: spec.amount } : {}),
    // a phone call: who and the full number, on the owner's card only (title/detail stay masked)
    ...(spec.call ? { call: spec.call } : {}),
    // a meeting to join: the full code, on the owner's card only (title stays masked)
    ...(spec.meet ? { meet: spec.meet } : {}),
    status: "pending",
  };
  const tool: ToolActivity = { id: call.id, name: call.function.name, title: title.slice(0, 60), state: "needs_approval", summary: "확인 필요", startedAt: now };
  core.db.tx(() => {
    core.db.insertMessage({ id: messageId, threadId, role: "assistant", text: "회의 중에 부탁받은 일이에요. 확인해 주시면 진행할게요.", cards: [card], tools: [tool], llm: [], createdAt: now });
    core.db.insertApproval({
      id: approvalId,
      userId,
      threadId,
      messageId,
      callJson: JSON.stringify(call),
      priorJson: JSON.stringify(prior),
      specJson: JSON.stringify(spec),
      now,
      expiresAt: now + APPROVAL_TTL_MS,
    });
    core.db.setUnread(threadId, userId, true);
  });
  publishMessage(core, messageId);
  publishThread(core, threadId);
  core.events.publish(userId, { type: "notification", title: "회의에서 부탁받은 일", body: spec.title.slice(0, 80), threadId, messageId, icon: "people" });
}
