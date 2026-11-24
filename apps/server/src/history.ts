/**
 * Conversation history replay for runTurn: stored `llm_json` (the LLM messages a turn produced)
 * → a valid OpenAI-style message list. Guarantees:
 *   - no system messages, no duplicated tool calls (dedupe by tool_call id)
 *   - every assistant tool_call is immediately followed by its tool result, otherwise the call is
 *     stripped (pending approval fragments, interrupted turns) and orphan tool results are dropped
 *   - consecutive identical user messages collapse (steered text echoed by the agent loop)
 *   - the window never starts with a tool result
 */
import type { LlmMessage, LlmToolCall } from "@pickle/agent";
import { letters, speakable, speechNorm } from "@pickle/protocol";
import type { MessageRow } from "./db/index.ts";
import { safeJson } from "./util.ts";

export const HISTORY_MESSAGES = 30;

export function sanitizeHistory(input: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  const seenCalls = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const m = input[i]!;
    if (m.role === "system" || m.role === "tool") continue; // tool results are consumed by their assistant block
    if (m.role === "user") {
      const content = typeof m.content === "string" ? m.content : "";
      if (!content.trim()) continue;
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && prev.content === content) continue;
      out.push({ role: "user", content });
      continue;
    }
    // assistant
    const content = typeof m.content === "string" && m.content.trim() ? m.content : null;
    const calls: LlmToolCall[] = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!calls.length) {
      if (content) out.push({ role: "assistant", content });
      continue;
    }
    const results = new Map<string, LlmMessage>();
    let j = i + 1;
    while (j < input.length && input[j]!.role === "tool") {
      const t = input[j] as Extract<LlmMessage, { role: "tool" }>;
      if (!results.has(t.tool_call_id)) results.set(t.tool_call_id, t);
      j++;
    }
    const kept = calls.filter((c) => c && typeof c.id === "string" && results.has(c.id) && !seenCalls.has(c.id));
    if (kept.length) {
      out.push({ role: "assistant", content, tool_calls: kept });
      for (const c of kept) {
        seenCalls.add(c.id);
        out.push(results.get(c.id)!);
      }
    } else if (content) {
      out.push({ role: "assistant", content });
    }
    i = j - 1;
  }
  return out;
}

/** Upper bound on replayed history, in UTF-8 bytes of the JSON messages. */
export const HISTORY_MAX_BYTES = 24 * 1024;

/** an html artifact's own HTML replayed whole only from the last turn, and only this small (for "색만 바꿔줘") */
export const HTML_REPLAY_MAX_BYTES = 12 * 1024;

/** what an older design-guide result says instead of the ~6 KB guide (the model asks again when it draws) */
export const HTML_GUIDE_REPLAY = JSON.stringify({ ok: true, summary: "화면 가이드를 확인했어요", data: { guide: '(omitted here: call with kind "html" and content "" again when drawing)' } });

/**
 * The HTML a sys_create_artifact call carried (kind "html", up to 150 KB) would crowd everything else out of the
 * replay window: older calls keep their title and kind and say how big the HTML was instead. The last turn's (after
 * the last user message) stays whole when it is at most HTML_REPLAY_MAX_BYTES, so a follow-up edit can start from it.
 * A design-guide call's result (content "", or a stand-in word) stays whole in the last turn too, so a follow-up card
 * ("결혼식 추가해서 다시 보여줘") is drawn with the guide at hand (the model does not ask for it again there); in older
 * turns it is replaced by HTML_GUIDE_REPLAY.
 */
export function compactHtmlCalls(msgs: LlmMessage[]): LlmMessage[] {
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  const guideCalls = new Set<string>(); // older turns' guide calls, whose results are replaced
  // a card deleted from the archive keeps its call without content (archive.ts forgetArtifactCall): not a guide call,
  // its result says it was deleted
  const deletedCalls = new Set<string>();
  for (const m of msgs) {
    if (m.role === "tool" && m.content.includes('"deleted":true') && safeJson<{ deleted?: unknown } | null>(m.content, null)?.deleted === true)
      deletedCalls.add(m.tool_call_id);
  }
  return msgs.map((m, i) => {
    if (m.role === "tool") return guideCalls.has(m.tool_call_id) ? { ...m, content: HTML_GUIDE_REPLAY } : m;
    if (m.role !== "assistant" || !m.tool_calls?.length) return m;
    let changed = false;
    const calls = m.tool_calls.map((c) => {
      if (c.function?.name !== "sys_create_artifact" || deletedCalls.has(c.id) || !c.function.arguments.includes("html")) return c;
      const a = safeJson<Record<string, unknown> | null>(c.function.arguments, null);
      if (!a || a.kind !== "html") return c;
      const content = typeof a.content === "string" ? a.content : "";
      const body = content.trim();
      if (!body || (body.length <= 16 && !/[<\s]/.test(body))) {
        if (i < lastUser) guideCalls.add(c.id);
        return c;
      }
      const bytes = Buffer.byteLength(content);
      if (i > lastUser && bytes <= HTML_REPLAY_MAX_BYTES) return c;
      changed = true;
      const note = `(HTML ${Math.max(1, Math.round(bytes / 1024))}KB, 보관함에 있어요 — 여기선 생략)`;
      return { ...c, function: { ...c.function, arguments: JSON.stringify({ ...a, content: note }) } };
    });
    return changed ? { ...m, tool_calls: calls } : m;
  });
}

/**
 * Last `n` messages and at most `maxBytes`, cut on a safe boundary: never inside an
 * assistant→tool block, preferably at a user message. The last user message is always kept
 * (resume history must end with the original request).
 */
export function trimHistory(msgs: LlmMessage[], n = HISTORY_MESSAGES, maxBytes = HISTORY_MAX_BYTES): LlmMessage[] {
  let start = Math.max(0, msgs.length - n);
  while (start < msgs.length && msgs[start]!.role === "tool") start++;
  // prefer starting at a user message
  let k = start;
  while (k < msgs.length && msgs[k]!.role !== "user") k++;
  if (start > 0 && k < msgs.length && k - start <= 4) start = k;

  const size = (m: LlmMessage) => Buffer.byteLength(JSON.stringify(m));
  let total = 0;
  for (let i = start; i < msgs.length; i++) total += size(msgs[i]!);
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  while (total > maxBytes) {
    let next = start + 1;
    while (next < msgs.length && msgs[next]!.role !== "user") next++;
    if (next >= msgs.length || next > lastUser) break;
    for (let i = start; i < next; i++) total -= size(msgs[i]!);
    start = next;
  }
  return start === 0 ? msgs : msgs.slice(start);
}

function llmOf(row: MessageRow): LlmMessage[] | null {
  const parsed = safeJson<unknown>(row.llm_json, null);
  return Array.isArray(parsed) ? (parsed as LlmMessage[]) : null;
}

/**
 * History-only assistant reply for a request the user stopped before anything was produced, so
 * the next turn doesn't pick the stopped request back up. Never shown in the chat.
 */
export const CANCEL_NOTE = "(사용자가 이 요청을 멈췄어요. 다시 부탁하기 전에는 이어서 처리하지 않아요.)";
export const CANCEL_NOTE_MESSAGE: LlmMessage = { role: "assistant", content: CANCEL_NOTE };
/**
 * Added to the system prompt only while the history holds a cancel note. Measured on the live model
 * (3 requests, "고마워"-style follow-ups): without it the stopped request was answered anyway in
 * 5/40 replies, with it in 0/40. Through the real flow (a long list stopped after its first lines, then "고마워";
 * ultrafast, n=20): 0/20 — once a stop with partial text also gets the note (turns.ts persist). Before that the rule
 * never fired for partial text and the list was picked back up in 3–4/20.
 */
export const CANCEL_RULE =
  '# 멈춘 요청\n대화 기록에서 "(사용자가 이 요청을 멈췄어요…)"가 붙은 요청은 사용자가 취소한 거예요. 사용자가 그 요청을 다시 부탁하기 전에는 그 요청에 답하거나 결과를 말하지 말고, 지금 메시지에만 답하세요.';

export function hasCancelNote(llm: LlmMessage[] | null | undefined): boolean {
  return !!llm?.some((m) => m.role === "assistant" && m.content === CANCEL_NOTE);
}

/**
 * History-only note for a reply the person talked over in a voice call (its heard report, POST …/heard): it takes the
 * place of the Stop button's CANCEL_NOTE on that reply, and marks a finished reply that was cut too. A spoken
 * interruption often goes on with the request or corrects it ("아 그리고 저녁 것도", "아니 그거 말고 목요일"), and the
 * Stop note made the model drop the request it had been answering ("아까 점심 메뉴는 멈추셔서 저녁만 골라드릴게요").
 * Real-model probe (2026-11-14, ultrafast, voice mode, 14 barge-in lines: continuations, corrections, topic changes,
 * plain stops; cut while generating and after it finished; 96 runs per note; LLM judge "does the next reply cover the
 * right thing"): continuations cut while generating: the Stop note 4/21, no note 14/21, this note 20/21; corrections
 * 15/15, topic changes 6/6 and plain stops 6/6 · 6/6 · 5/6 with each (the 5/6: "멈출게요" plus a word on a card it had
 * saved). Finished replies (no note before): continuations 16/21 and 18/21 with no note, 20/21 with it. No rule in the
 * system prompt goes with it.
 */
export const VOICE_NOTE = "(사용자가 답을 끊고 말했어요. 앞 요청을 새 말과 함께 판단해요.)";
export const VOICE_NOTE_MESSAGE: LlmMessage = { role: "assistant", content: VOICE_NOTE };

/** the mark a reply cut to what the user heard ends with (cutToHeard) */
export const HEARD_CUT = "…";

const HEARD_BACKSTEPS = 8;

/**
 * Where a cut that keeps the first `n` spoken letters of `text` ends: the first word end whose prefix, spoken, begins
 * with them (0 = nothing). In plain text that is the end of the word holding the n-th letter. A prefix with markdown
 * still open (a link, a code fence) speaks letters the whole reply doesn't, so it doesn't count yet. Found by a binary
 * search over the word ends (speakable() of a prefix is O(length): scanning every end was quadratic, 400 ms of blocked
 * event loop at 20 000 characters), then a few steps back while the end before also qualifies (markdown that closes
 * late can leave the search past the first such end).
 */
export function heardEnd(text: string, n: number): number {
  if (n <= 0) return 0;
  const want = speechNorm(speakable(text)).slice(0, n);
  const ends: number[] = [];
  for (let i = 1; i <= text.length; i++) if (i === text.length || /\s/.test(text[i]!)) ends.push(i);
  const heardBy = (k: number) => speechNorm(speakable(text.slice(0, ends[k]))).startsWith(want);
  let lo = 0;
  let hi = ends.length - 1;
  if (!heardBy(hi)) return text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (heardBy(mid)) hi = mid;
    else lo = mid + 1;
  }
  for (let back = 0; back < HEARD_BACKSTEPS && lo > 0 && heardBy(lo - 1); back++) lo--;
  return ends[lo]!;
}

/**
 * A voice reply the user cut off (barge-in while it was spoken): its history keeps only what was heard, so the next
 * turn knows what the user did and didn't hear. `heard` is the spoken text the user heard (a prefix of
 * speakable(row.text)); it is counted in spoken letters (@pickle/protocol `letters(speakable(…))`, the same count the
 * app used), so markdown, emoji and spacing don't shift the cut.
 *   - the assistant text holding the cut keeps its heard words, then HEARD_CUT ("…"); nothing heard → just "…"
 *   - assistant text after it is dropped (a message with tool calls keeps its calls, content null)
 *   - user (steered) and tool messages and the notes (CANCEL_NOTE, VOICE_NOTE) stay where they are, uncounted
 * Returns null when nothing changes: everything was heard, or the same cut was already made (idempotent).
 */
export function cutToHeard(llm: LlmMessage[], heard: string): LlmMessage[] | null {
  let left = letters(speakable(heard));
  let cut = false;
  const out: LlmMessage[] = [];
  for (const m of llm) {
    const text = m.role === "assistant" && typeof m.content === "string" && m.content !== CANCEL_NOTE && m.content !== VOICE_NOTE ? m.content : null;
    const n = text === null ? 0 : letters(speakable(text));
    if (text === null || n === 0) {
      out.push(m);
      continue;
    }
    if (cut) {
      if (m.role === "assistant" && m.tool_calls?.length) out.push({ ...m, content: null });
      continue;
    }
    if (left >= n) {
      left -= n;
      out.push(m);
      continue;
    }
    const end = heardEnd(text, left);
    // heard into its last word, or the rest is the mark of the same cut made before: heard whole, unchanged
    if (!letters(speakable(text.slice(end)))) {
      left = 0;
      out.push(m);
      continue;
    }
    cut = true;
    const head = text.slice(0, end).trimEnd();
    out.push({ ...m, content: head.endsWith(HEARD_CUT) ? head : head + HEARD_CUT });
  }
  return JSON.stringify(out) === JSON.stringify(llm) ? null : out;
}

/**
 * A reply's history after a voice barge-in (`cut`: cutToHeard changed it): the Stop button's CANCEL_NOTE on it (the call
 * stopped the turn while it was generating) becomes VOICE_NOTE; a cut finished reply gets VOICE_NOTE too. A reply heard
 * whole that wasn't stopped is left as it is. Idempotent. Only this row changes: a CANCEL_NOTE that cancelInHistory put
 * on a steered user row stays, as that line came in after the reply was stored and really went unanswered.
 */
export function withVoiceNote(llm: LlmMessage[], cut: boolean): LlmMessage[] {
  const isNote = (m: LlmMessage) => m.role === "assistant" && (m.content === CANCEL_NOTE || m.content === VOICE_NOTE);
  const out = llm.filter((m) => !isNote(m));
  return out.length < llm.length || cut ? [...out, VOICE_NOTE_MESSAGE] : llm;
}

/** The launcher trims steered text and caps it at 4000 chars; compare on that form. */
const STEER_CAP = 4000;
export const steerKey = (s: string) => s.trim().slice(0, STEER_CAP);

/** What a user row sent to the model (attachments inlined), falling back to its visible text. */
export function userContentOf(row: MessageRow): string {
  const u = llmOf(row)?.find((m) => m.role === "user");
  return typeof u?.content === "string" ? u.content : row.text;
}

/** A system turn's request (a schedule's or the briefing's event row): its llm_json is the prompt, with no reply in it. */
export function isSystemRequest(row: MessageRow): boolean {
  if (row.role !== "event") return false;
  const llm = llmOf(row);
  return !!llm?.some((m) => m.role === "user") && !llm.some((m) => m.role === "assistant");
}

/**
 * The system request at `idx` got no reply: no assistant row comes after it before the next request (a user row that
 * wasn't steered into its turn, or another system request), or before the end. `answeredTail`: the rows stop right
 * before an assistant row (the paused reply of a resumed turn), so the end counts as a reply.
 */
function unanswered(list: MessageRow[], idx: number, answeredTail: boolean): boolean {
  for (let j = idx + 1; j < list.length; j++) {
    const r = list[j]!;
    if (r.role === "assistant") return false;
    if ((r.role === "user" && !r.steered) || isSystemRequest(r)) return true;
  }
  return !answeredTail;
}

/**
 * Personal threads: replay stored llm_json. A steered user row is skipped when the following
 * assistant row already contains the same text as an injected user message.
 * A system request that got no reply is left out (a briefing whose model call failed before failed attempts were
 * deleted, as on 11-18, or one cut off by a server that came back after the briefing window): replayed, it reads as the
 * latest unanswered request, and the model would answer it in the person's next turn.
 */
export function historyFromRows(rows: MessageRow[], opts: { excludeTrailingUserTexts?: Set<string>; answeredTail?: boolean } = {}): LlmMessage[] {
  let list = rows;
  if (opts.excludeTrailingUserTexts?.size) {
    const ex = new Set([...opts.excludeTrailingUserTexts].map(steerKey));
    let end = list.length;
    while (end > 0 && list[end - 1]!.role === "user" && ex.has(steerKey(userContentOf(list[end - 1]!)))) end--;
    list = list.slice(0, end);
  }
  const out: LlmMessage[] = [];
  for (let idx = 0; idx < list.length; idx++) {
    const row = list[idx]!;
    const llm = llmOf(row);
    if (row.steered && row.role === "user") {
      const next = list.slice(idx + 1).find((r) => r.role === "assistant");
      const nextLlm = next ? llmOf(next) : null;
      const key = steerKey(userContentOf(row));
      if (nextLlm?.some((m) => m.role === "user" && typeof m.content === "string" && steerKey(m.content) === key)) continue;
    }
    if (isSystemRequest(row) && unanswered(list, idx, !!opts.answeredTail)) continue;
    if (llm) {
      // an explicit [] means "nothing for history" (e.g. a turn paused for approval — its
      // messages travel with the approval and come back at the start of the resumed turn)
      out.push(...llm);
      continue;
    }
    if (row.role === "user") out.push({ role: "user", content: row.text });
    else if (row.role === "assistant" && row.text.trim()) out.push({ role: "assistant", content: row.text });
    // event rows without llm_json are UI-only (e.g. "친구가 되었어요")
  }
  return trimHistory(compactHtmlCalls(sanitizeHistory(out)));
}

/**
 * Friend (shared) threads: text-only replay from the perspective of `agentOwnerId`'s agent.
 * Its own agent messages are assistant turns; everything else is attributed user content.
 */
export function friendHistoryFromRows(
  rows: MessageRow[],
  agentOwnerId: string,
  names: (userId: string | null) => { display: string; agent: string },
): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const row of rows) {
    if (!row.text.trim()) continue;
    if (row.author_kind === "agent" && row.author_user_id === agentOwnerId) {
      out.push({ role: "assistant", content: row.text });
      continue;
    }
    const n = names(row.author_user_id);
    const who = row.role === "event" ? "알림" : row.author_kind === "agent" ? `${n.display} 님의 모시(${n.agent})` : `${n.display} 님`;
    out.push({ role: "user", content: `[${who}] ${row.text}` });
    // the owner stopped their agent on this message: replay the cancellation (owner's agent only)
    if (row.author_user_id === agentOwnerId && hasCancelNote(llmOf(row))) out.push(CANCEL_NOTE_MESSAGE);
  }
  return trimHistory(sanitizeHistory(out));
}

/**
 * Resume after an approval: priorMessages (from the paused turn) already carry the user text and
 * the assistant tool call, so drop the paused turn's trailing user row from the replayed history.
 */
export function historyForResume(rowsBeforePaused: MessageRow[], priorMessages: LlmMessage[]): LlmMessage[] {
  const priorUser = new Set(priorMessages.filter((m) => m.role === "user").map((m) => (m as { content: string }).content));
  return historyFromRows(rowsBeforePaused, { excludeTrailingUserTexts: priorUser, answeredTail: true });
}
