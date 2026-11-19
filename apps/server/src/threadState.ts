/**
 * The drawer's per-thread fields (drawer B):
 *  - `preview`: the first sentence of the agent's latest final answer or event note, masked here so no phone number,
 *    email, code, card/account number or amount reaches the list;
 *  - `waiting`: what the thread is waiting on right now, approval > call > meeting.
 * Both are computed when a thread is viewed, so a list and an upsert always agree. Every change already publishes a
 * thread upsert: final answers are stored at turn end and event notes publish their thread; approvals publish on
 * insert and on decision (threads.ts), and on expiry through the timer below; phone.ts publishes around a dial;
 * meet.ts posts a note (and publishes) on each state change that changes the text.
 */
import type { ThreadWaiting } from "@pickle/protocol";
import { publishThread, type Core } from "./core.ts";
import type { ThreadRow } from "./db/index.ts";
import { maskPhone, normalizePhone } from "./phone.ts";
import { safeJson } from "./util.ts";

export const PREVIEW_MAX = 60;

// ───────────────────────────── masking ─────────────────────────────

const last4 = (digits: string) => digits.replace(/\D/g, "").slice(-4);
const digitCount = (s: string) => s.replace(/\D/g, "").length;

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const MEET_CODE = /\b([a-z]{3})-[a-z]{4}-([a-z]{3})\b/g;
const RRN = /(?<![\d*])\d{6}\s*-\s*[1-8]\d{6}(?![\d*])/g;
const CARD = /(?<![\d*])\d(?:[ -]?\d){12,18}(?![\d*])/g;
/** other countries: +1 415 555 0123, +44 20 7946 0958 (Korean +82 numbers go through PHONE) */
const INTL_PHONE = /(?<![\d*])\+(?!82)\d{1,3}(?:[ .-]?\d{2,4}){2,5}(?![\d*])/g;
/** Korean numbers as people write them: 010-1234-5678, 01012345678, 02 123 4567, +82 10-1234-5678 */
const PHONE = /(?<![\d*+])(?:\+82[ -]?)?0?(?:1[016789]|2|[3-6][1-5]|70)[ .-]?\d{3,4}[ .-]?\d{4}(?![\d*])/g;
/** digit groups joined by hyphens, ≥10 digits in all (account numbers); dates (8 digits) stay */
const GROUPED = /(?<![\d*])\d{2,6}(?:-\d{2,8}){1,4}(?![\d*])/g;
const CODE_AFTER_WORD =
  /(인증\s*번호|인증\s*코드|확인\s*코드|보안\s*코드|코드|OTP|otp|PIN|pin|핀\s*번호|비밀\s*번호|비번)(\s*(?:는|은|이|가|를|을|:|=)?\s*)\d[\d -]{2,10}\d/g;
const AMOUNT = /(?:\d[\d,]*(?:\.\d+)?\s*(?:억|만|천|백)?\s*)+(?:원|달러)/g;
const CURRENCY_SIGN = /([$₩])\s?\d[\d,]*(?:\.\d+)?/g;
const LONG_RUN = /(?<![\d*.,:])\d{6,}(?![\d*.,:])/g;

/** Masks what must not show in a list row. Already-masked text ("010-****-5678", "rak-****-kud") is left alone. */
export function maskSensitive(text: string): string {
  return text
    .replace(EMAIL, "$1***@$2")
    .replace(MEET_CODE, "$1-****-$2")
    .replace(RRN, "******-*******")
    .replace(CARD, (m) => `****-${last4(m)}`)
    .replace(INTL_PHONE, (m) => {
      const e164 = normalizePhone(m);
      return e164 ? maskPhone(e164) : `****-${last4(m)}`;
    })
    .replace(PHONE, (m) => {
      const e164 = normalizePhone(m);
      return e164 ? maskPhone(e164) : `****-${last4(m)}`;
    })
    .replace(GROUPED, (m) => (digitCount(m) >= 10 ? `****-${last4(m)}` : m))
    .replace(CODE_AFTER_WORD, (_m, word: string, sep: string) => `${word}${sep}****`)
    .replace(AMOUNT, (m) => m.replace(/\d[\d,]*(?:\.\d+)?/g, "***"))
    .replace(CURRENCY_SIGN, "$1***")
    .replace(LONG_RUN, "****");
}

// ───────────────────────────── preview ─────────────────────────────

// A "*" right before VS16 or U+20E3 is the keycap "*️⃣" (as in the app's markdown.tsx): it stays in the line, and it
// never opens or closes bold or italic (it may sit inside them).

/** a line that is only a heading ("**회의 요약**", "## 결과") or a status/attachment line ("[첨부: …]") */
const SKIP_LINE = /^(?:#{1,6}\s.*|\*\*(?:[^*]|\*(?=[\uFE0F\u20E3]))+\*\*:?|__[^_]+__:?|\[[^\]]*\]|```.*|---+|\|.*\|)$/;

function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*(?:[-*+•]|\d{1,2}[.)])\s+/, "") // list markers
    .replace(/^\s*>\s?/, "") // quotes
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/(\*\*|__)(?![\uFE0F\u20E3])(.+?)\1(?![\uFE0F\u20E3])/g, "$2")
    .replace(/(^|[^\w*])\*(?![\uFE0F\u20E3])((?:[^*\n]|\*(?=[\uFE0F\u20E3]))+)\*(?=[^\w*\uFE0F\u20E3]|\*[\uFE0F\u20E3]|$)/g, "$1$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .trim();
}

/** first sentence: up to the first . ! ? … followed by a space (or the end); "3.5" and "7:00" do not end one */
function firstSentence(text: string): string {
  const m = /[.!?…](?=\s|$)/.exec(text);
  return m ? text.slice(0, m.index + 1) : text;
}

/** ≤ max chars, cut at a word boundary with "…" */
export function clip(text: string, max = PREVIEW_MAX): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  const cut = space >= Math.floor(max / 2) ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,·:;-]+$/, "")}…`;
}

/** The list-row line for one stored agent message; "" when nothing readable is left. */
export function previewOf(raw: string): string {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const body = lines.filter((l) => !SKIP_LINE.test(l));
  const text = (body.length ? body : lines)
    .map(stripMarkdown)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return clip(firstSentence(maskSensitive(text)).trim());
}

/** The thread's latest agent line (final answer or event note, whichever is later). */
export function threadPreview(core: Core, threadId: string): string {
  const rows = core.db.sql
    .query<{ text: string }, [string]>(
      `SELECT text FROM messages WHERE thread_id = ? AND role IN ('assistant', 'event') AND text != '' ORDER BY created_at DESC, rowid DESC LIMIT 5`,
    )
    .all(threadId);
  for (const r of rows) {
    const p = previewOf(r.text);
    if (p) return p;
  }
  return "";
}

// ───────────────────────────── waiting ─────────────────────────────

export const WAITING_TEXT = {
  approvalCall: "전화 승인을 기다려요",
  approvalMeet: "회의 참여 승인을 기다려요",
  approvalPay: "결제 승인을 기다려요",
  approvalSend: "보내기 승인을 기다려요",
  dialing: "전화를 거는 중이에요",
  meetJoining: "회의에 들어가는 중이에요",
  meetAdmission: "호스트 수락을 기다려요",
  meetLive: "회의 중 · 듣고 받아 적고 있어요.",
} as const;

const dialing = new WeakMap<Core, Set<string>>();

/** phone.ts: a `call` thread whose dial is running (TTS + placing the call). */
export function setDialing(core: Core, threadId: string, on: boolean): void {
  let set = dialing.get(core);
  if (!set) dialing.set(core, (set = new Set()));
  if (on) set.add(threadId);
  else set.delete(threadId);
}

const expiryTimers = new WeakMap<Core, Map<string, ReturnType<typeof setTimeout>>>();

/** Approvals expire lazily in the DB; one upsert at the expiry time turns the row's `waiting` off. */
function refreshAtExpiry(core: Core, threadId: string, approvalId: string, expiresAt: number): void {
  let timers = expiryTimers.get(core);
  if (!timers) expiryTimers.set(core, (timers = new Map()));
  if (timers.has(approvalId)) return;
  const delay = Math.min(Math.max(0, expiresAt - core.now()) + 1_000, 2_147_000_000);
  const handle = setTimeout(() => {
    timers.delete(approvalId);
    try {
      publishThread(core, threadId);
    } catch {
      /* the app closed meanwhile */
    }
  }, delay);
  (handle as { unref?: () => void }).unref?.();
  timers.set(approvalId, handle);
}

function approvalText(specJson: string, callJson: string): string {
  const spec = safeJson<{ call?: unknown; meet?: unknown; amount?: unknown }>(specJson, {});
  if (spec.call) return WAITING_TEXT.approvalCall;
  if (spec.meet) return WAITING_TEXT.approvalMeet;
  if (typeof spec.amount === "number") return WAITING_TEXT.approvalPay;
  const name = safeJson<{ function?: { name?: unknown } }>(callJson, {}).function?.name;
  if (name === "sys_join_meet") return WAITING_TEXT.approvalMeet;
  if (name === "sys_phone_call") return WAITING_TEXT.approvalCall;
  return WAITING_TEXT.approvalSend;
}

const MEET_TEXT: Record<string, string> = {
  launching: WAITING_TEXT.meetJoining,
  prejoin: WAITING_TEXT.meetJoining,
  waiting_admission: WAITING_TEXT.meetAdmission,
  in_call: WAITING_TEXT.meetLive,
};

export function threadWaiting(core: Core, t: ThreadRow, viewerId: string): ThreadWaiting | null {
  const now = core.now();
  const a = core.db.sql
    .query<{ id: string; spec_json: string; call_json: string; expires_at: number }, [string, string, number]>(
      `SELECT id, spec_json, call_json, expires_at FROM approvals
       WHERE user_id = ? AND thread_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(viewerId, t.id, now);
  if (a) {
    refreshAtExpiry(core, t.id, a.id, a.expires_at);
    return { kind: "approval", text: approvalText(a.spec_json, a.call_json) };
  }
  if (dialing.get(core)?.has(t.id)) return { kind: "call", text: WAITING_TEXT.dialing };
  if (t.kind === "call") {
    const state = core.meet?.byThread(viewerId, t.id)?.state;
    const text = state ? MEET_TEXT[state] : undefined;
    if (text) return { kind: "meeting", text };
  }
  return null;
}
