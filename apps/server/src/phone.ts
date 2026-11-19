/**
 * Outbound phone calls (Twilio REST Calls API) and the two server tools built on them:
 *  - `sys_phone_call`: call someone else. Always approval-gated.
 *  - `sys_call_me`: call the user's OWN verified number (나의 모시 > 내 전화번호). Not approval-gated, so
 *    scheduled tasks (wake-up / reminder calls) can use it; safety is number verification + 10 calls a KST day.
 * Both go through one `dial()`: when the local Drama-3 TTS and a public audio URL are available, the message
 * is synthesized BEFORE dialling and played with `<Play>` (모시's own voice); otherwise, or on any TTS/tunnel
 * failure, `<Say language="ko-KR">`. Trial-account fallbacks (Echo twimlet, +82 0… recipients) apply to both.
 * Each tool call creates a `call` thread ("○○님께 전화" / "내 휴대폰으로 전화", "<agentName>의 외부 통화").
 * Phone numbers never reach logs; the LLM only ever sees a masked number.
 */
import type { ToolContext, ToolDef, ToolResult } from "@pickle/agent";
import type { Core } from "./core.ts";
import { publishMessage, publishThread } from "./core.ts";
import { kstDate } from "./kst.ts";
import { escapeXml, newId, safeJson } from "./util.ts";
import { errInfo } from "./log.ts";
import { setDialing } from "./threadState.ts";

interface PhoneArgs {
  to: string;
  message: string;
  name?: string;
  digits?: string;
}

interface CallMeArgs {
  message: string;
  digits?: string;
}

/** Keys to press after the call connects (meeting PIN, extension): 0-9 * # and w (half-second wait). */
export function normalizeDigits(raw: unknown): string | null {
  if (raw == null || raw === "") return "";
  const s = String(raw).replace(/[\s.-]/g, "");
  return /^[0-9*#w]{1,40}$/.test(s) ? s : null;
}

/** Twilio's hosted Echo twimlet: returns the given TwiML (used when inline `Twiml` is not allowed, e.g. trial). */
export function twimlEchoUrl(twiml: string): string {
  return `https://twimlets.com/echo?Twiml=${encodeURIComponent(twiml)}`;
}

/**
 * Inline TwiML: optionally wait for the line's prompt and press `digits` (e.g. a Google Meet PIN), then speak.
 * With `audioUrl` (a pre-synthesized mp3 Twilio can fetch) every spoken part is `<Play>` instead of `<Say>`.
 * `repeat` (verification codes) speaks the message twice after a short pause.
 */
export function phoneTwiml(message: string, digits = "", audioUrl: string | null = null, repeat = false): string {
  const say = audioUrl ? `<Play>${escapeXml(audioUrl)}</Play>` : `<Say language="ko-KR">${escapeXml(message)}</Say>`;
  if (!digits) return repeat ? `<Response><Pause length="1"/>${say}<Pause length="1"/>${say}</Response>` : `<Response>${say}</Response>`;
  // conference lines greet first ("PIN을 입력하고 # …"); after the PIN they announce the join
  return `<Response><Pause length="4"/><Play digits="${digits}"/><Pause length="5"/>${say}<Pause length="1"/>${say}</Response>`;
}

/** Korean / E.164 number → E.164, or null. */
export function normalizePhone(raw: string): string | null {
  let s = String(raw ?? "").replace(/[\s().-]/g, "");
  if (/^\+820\d{8,10}$/.test(s)) s = "+82" + s.slice(4); // "+82 010-…": drop the domestic trunk 0
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  if (/^0\d{8,10}$/.test(s)) return "+82" + s.slice(1);
  if (/^82\d{8,11}$/.test(s)) return "+" + s;
  return null;
}

/**
 * E.164 → how the person writes it, for the approval card only (never logs, never the model's text):
 * "010-1234-5678", "011-123-4567", "02-123-4567", "02-1234-1234", "031-123-4567", "070-1234-5678", "0505-123-4567";
 * "+1 415-555-0123" for North America; other countries stay E.164.
 */
export function formatPhone(e164: string): string {
  if (e164.startsWith("+82")) {
    const d = "0" + e164.slice(3);
    if (d.startsWith("02")) return d.length === 9 ? `02-${d.slice(2, 5)}-${d.slice(5)}` : d.length === 10 ? `02-${d.slice(2, 6)}-${d.slice(6)}` : d;
    if (/^050\d/.test(d) && (d.length === 11 || d.length === 12)) return `${d.slice(0, 4)}-${d.slice(4, d.length - 4)}-${d.slice(-4)}`;
    if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
    return d;
  }
  if (e164.startsWith("+1") && e164.length === 12) return `+1 ${e164.slice(2, 5)}-${e164.slice(5, 8)}-${e164.slice(8)}`;
  return e164;
}

export function maskPhone(e164: string): string {
  if (e164.startsWith("+82")) {
    const local = "0" + e164.slice(3);
    if (local.startsWith("02") && local.length >= 9) return `02-****-${local.slice(-4)}`; // Seoul: not "021-****-…"
    return local.length >= 10 ? `${local.slice(0, 3)}-****-${local.slice(-4)}` : `${local.slice(0, 2)}**${local.slice(-2)}`;
  }
  if (e164.startsWith("+1") && e164.length === 12) return `+1 ${e164.slice(2, 5)}-***-${e164.slice(-4)}`;
  return `${e164.slice(0, 3)}****${e164.slice(-4)}`;
}

// ───────────────────────────── dial ─────────────────────────────

const VOICE_STATUS = "목소리를 만드는 중";
/** a call waits at most this long for its voice before falling back to `<Say>` */
export const PHONE_TTS_WAIT_MS = 45_000;
/**
 * The phone tools' own deadline (ToolDef.timeoutMs), longer than the 25 s chat default: the voice can take up to
 * PHONE_TTS_WAIT_MS, then Twilio. They report "목소리를 만드는 중" every 20 s, so the turn idle watchdog stays fed.
 */
export const PHONE_TOOL_TIMEOUT_MS = 60_000;
/** skip TTS when this many lines are already waiting or running on the (single-GPU) service */
export const PHONE_TTS_MAX_QUEUE = 2;

/**
 * Synthesizes the message with the local TTS and registers a 15-minute public token for it.
 * Null (→ `<Say>`) when TTS or the public audio URL is unavailable, the service is busy (queue ≥ 2),
 * or synthesis fails or takes over 45 s; rethrows only when the caller was cancelled (then no call is
 * placed). Never logs text or numbers.
 */
async function callAudioUrl(core: Core, message: string, signal: AbortSignal, status?: (s: string) => void): Promise<string | null> {
  const voice = core.voice;
  const tts = voice.tts;
  if (!tts || !voice.publicBase()) return null;
  const line = tts.cachedLine(message);
  if (!line) {
    const h = await tts.health();
    if (!h?.ready) {
      core.log.warn("call voice unavailable; using basic voice", { reason: h ? "loading" : "unreachable" });
      return null;
    }
    if ((h.queue ?? 0) >= PHONE_TTS_MAX_QUEUE) {
      core.log.info("call voice busy; using basic voice", { queue: h.queue });
      return null;
    }
  }
  status?.(VOICE_STATUS);
  // a turn aborts after turnIdleTimeoutMs without events; long lines take ~real time to synthesize
  const beat = status && !line ? setInterval(() => status(VOICE_STATUS), 20_000) : null;
  try {
    const r = line ?? (await tts.synthesize(message, { signal, waitMs: PHONE_TTS_WAIT_MS }));
    const base = voice.publicBase();
    if (!base) throw new Error("public audio URL went away");
    return `${base}/a/${voice.tokens.register(r.file)}.mp3`;
  } catch (err) {
    if (signal.aborted) throw err;
    core.log.warn("call voice unavailable; using basic voice", { err: errInfo(err) });
    return null;
  } finally {
    if (beat) clearInterval(beat);
  }
}

export type DialOutcome =
  | { ok: true; status: string }
  | { ok: false; error: "phone_not_configured" }
  | { ok: false; error: "phone_failed"; httpStatus: number; twilioCode?: number }
  | { ok: false; error: "phone_error" };

export interface DialRequest {
  /** E.164 */
  to: string;
  /** what to say (Korean) */
  message: string;
  /** keys to press after connecting (normalized) */
  digits?: string;
  /** say it twice (verification codes) */
  repeat?: boolean;
  signal: AbortSignal;
  /** progress for the UI while the voice is synthesized */
  status?: (s: string) => void;
}

/**
 * Places one call: TTS `<Play>` when available (else `<Say>`), then Twilio with the trial fallbacks
 * (inline Twiml refused → Echo twimlet Url; 573002 unverified → the +82 0… form). Never logs the number or text.
 */
export async function dial(core: Core, o: DialRequest): Promise<DialOutcome> {
  const tw = core.cfg.twilio;
  if (!tw) return { ok: false, error: "phone_not_configured" };
  try {
    const audioUrl = await callAudioUrl(core, o.message, o.signal, o.status);
    core.log.info("call voice", { mode: audioUrl ? "play" : "say" });
    const twiml = phoneTwiml(o.message, o.digits ?? "", audioUrl, o.repeat ?? false);
    const post = (params: Record<string, string>, toNumber = o.to) =>
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(tw.accountSid)}/Calls.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${tw.accountSid}:${tw.authToken}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: toNumber, From: tw.from, ...params }),
        signal: AbortSignal.any([o.signal, AbortSignal.timeout(15_000)]),
      });
    const codeOf = async (r: Response) => ((await r.clone().json().catch(() => ({}))) as { code?: number }).code;
    let how: Record<string, string> = { Twiml: twiml };
    let res = await post(how);
    if (res.status === 400 && (await codeOf(res)) === 0) {
      // trial accounts reject inline `Twiml` ("limited parameter access", code 0) but accept `Url`:
      // Twilio's own Echo twimlet serves the same TwiML back
      how = { Url: twimlEchoUrl(twiml) };
      res = await post(how);
    }
    if (res.status === 422 && (await codeOf(res)) === 573002 && /^\+82[1-9]/.test(o.to)) {
      // trial: "not a verified recipient". Korean numbers are often verified as typed with the
      // domestic 0 ("+82 010-…"); Twilio matches that literally, so try that form once
      res = await post(how, "+820" + o.to.slice(3));
    }
    const data = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string; code?: number };
    if (res.ok) return { ok: true, status: data.status ?? "queued" };
    // Twilio error codes (21219 unverified on trial, 21215 geo permission, …); the message may contain the number
    core.log.warn("twilio call failed", { status: res.status, code: data.code });
    return { ok: false, error: "phone_failed", httpStatus: res.status, twilioCode: data.code };
  } catch (err) {
    core.log.warn("twilio call error", { err: errInfo(err) });
    return { ok: false, error: "phone_error" };
  }
}

/** A tool's call: the `call` thread (추가 대화) + dial + the event note. `target`/`ke` read "단아님"+"께", "내 휴대폰"+"으로". */
async function callWithThread(
  core: Core,
  ctx: ToolContext,
  o: { to: string; message: string; digits: string; title: string; target: string; ke: string },
): Promise<ToolResult> {
  const masked = maskPhone(o.to);
  const { target, ke, message } = o;
  const label = target === masked ? masked : `${target}(${masked})`; // a bare number is not repeated
  const threadId = newId("t");
  core.db.createThread(
    { id: threadId, ownerId: ctx.userId, kind: "call", title: o.title, subtitle: `${ctx.agentName}의 외부 통화`, icon: "phone-out", now: core.now() },
    [ctx.userId],
  );
  // the drawer shows the call (waiting "전화를 거는 중이에요") while the voice is synthesized and the call placed
  setDialing(core, threadId, true);
  publishThread(core, threadId);
  let r: DialOutcome;
  try {
    r = await dial(core, { to: o.to, message, digits: o.digits, signal: ctx.signal, status: (s) => ctx.status?.(s) });
  } finally {
    setDialing(core, threadId, false);
  }
  let result: ToolResult;
  let note: string;
  if (r.ok) {
    result = { ok: true, summary: `${target}${ke} 전화를 걸었어요`, data: { status: r.status, to: masked } };
    note = `${label}${ke} 전화를 걸었어요.\n전한 말: “${message}”`;
  } else if (r.error === "phone_not_configured") {
    result = {
      ok: false,
      summary: "전화 연결 서비스(Twilio)가 아직 설정되지 않았어요",
      data: {
        error: "phone_not_configured",
        to: masked,
        hint: "오류 코드는 말하지 말고, 모시 서비스 쪽 전화 연결이 아직 준비되지 않아 지금은 걸 수 없다고만 짧게 안내하세요. 사용자가 앱 설정에서 해결할 수 있는 문제가 아니에요.",
      },
    };
    note = `${label}${ke} 걸려던 전화는 전화 연결 서비스가 설정되지 않아 연결하지 못했어요.\n전하려던 말: “${message}”`;
  } else if (r.error === "phone_failed") {
    result = { ok: false, summary: "전화를 걸지 못했어요", data: { error: "phone_failed", status: r.httpStatus, twilioCode: r.twilioCode, to: masked } };
    note = `${label}${ke} 전화를 걸지 못했어요. 잠시 후 다시 시도해 주세요.`;
  } else {
    result = { ok: false, summary: "전화 연결 중에 문제가 생겼어요", data: { error: "phone_error", to: masked } };
    note = `${label}${ke} 전화하는 중에 문제가 생겼어요.`;
  }
  const mid = newId("m");
  core.db.insertMessage({ id: mid, threadId, role: "event", text: note, createdAt: core.now() });
  core.db.setUnread(threadId, ctx.userId, true);
  publishMessage(core, mid);
  publishThread(core, threadId);
  return result;
}

function checkMessage(raw: unknown, digitsRaw: unknown): { message: string; digits: string } | ToolResult {
  const message = String(raw ?? "").trim().slice(0, 300);
  if (!message) return { ok: false, summary: "전할 말이 비어 있어요", data: { error: "empty_message" } };
  const digits = normalizeDigits(digitsRaw);
  if (digits === null) return { ok: false, summary: "누를 번호는 숫자, *, #만 쓸 수 있어요", data: { error: "invalid_digits" } };
  return { message, digits };
}

// ───────────────────────────── the user's own number (나의 모시 > 내 전화번호) ─────────────────────────────

/** kv `sys:phone`. The E.164 number lives only here: never in logs, LLM text or tool data. */
export interface MyPhone {
  e164: string;
  verifiedAt: number | null;
  /** sha256(userId:code) of the pending 4-digit code */
  codeHash: string | null;
  codeExpiresAt: number;
  attempts: number;
}

const MY_PHONE_KEY = "sys:phone";

export function readMyPhone(core: Core, userId: string): MyPhone | null {
  const v = safeJson<Partial<MyPhone> | null>(core.db.kvGet(userId, MY_PHONE_KEY), null);
  if (!v || typeof v.e164 !== "string" || !v.e164) return null;
  return {
    e164: v.e164,
    verifiedAt: typeof v.verifiedAt === "number" ? v.verifiedAt : null,
    codeHash: typeof v.codeHash === "string" ? v.codeHash : null,
    codeExpiresAt: typeof v.codeExpiresAt === "number" ? v.codeExpiresAt : 0,
    attempts: typeof v.attempts === "number" ? v.attempts : 0,
  };
}

/** null clears the number (the kv row keeps an empty value) */
export function writeMyPhone(core: Core, userId: string, rec: MyPhone | null): void {
  core.db.kvSet(userId, MY_PHONE_KEY, rec ? JSON.stringify(rec) : "", core.now());
}

export function myPhoneView(rec: MyPhone | null): { masked: string; verified: boolean } | null {
  return rec ? { masked: maskPhone(rec.e164), verified: rec.verifiedAt !== null } : null;
}

export const CALL_ME_DAILY_LIMIT = 10;
const CALL_ME_KEY = "sys:call_me_day";
export const CALL_ME_NOT_VERIFIED = "먼저 나의 모시 > 내 전화번호를 등록하고 인증해 주세요";

/** Counts one call toward today's (KST) cap; false when the cap is already reached. */
function takeCallMeSlot(core: Core, userId: string): boolean {
  const day = kstDate(core.now());
  const v = safeJson<{ day?: string; n?: number } | null>(core.db.kvGet(userId, CALL_ME_KEY), null);
  const n = v?.day === day && typeof v.n === "number" ? v.n : 0;
  if (n >= CALL_ME_DAILY_LIMIT) return false;
  core.db.kvSet(userId, CALL_ME_KEY, JSON.stringify({ day, n: n + 1 }), core.now());
  return true;
}

// ───────────────────────────── tools ─────────────────────────────

/** A meeting / conference line rather than a person: no "님", and the question reads "…에 전화로 참여할까요?". */
function isMeeting(a: PhoneArgs): boolean {
  const n = typeof a.name === "string" ? a.name.trim() : "";
  return /(회의|미팅|컨퍼런스|콘퍼런스|meeting|meet|call|standup|daily|sync)$/i.test(n);
}

/**
 * A business, shop or public office rather than a person, judged by how the name ends ("연세바른치과", "스타벅스 강남점",
 * "서초구청"): no "님", and "에" instead of the honorific "께". Only multi-syllable endings, so given names ending in
 * 서/원/국 are not caught; a brand name with no such ending ("스타벅스") still reads as a person.
 */
const PLACE_ENDINGS = [
  "치과", "안과", "내과", "외과", "피부과", "소아과", "청소년과", "이비인후과", "산부인과", "비뇨기과", "의학과",
  "병원", "의원", "약국", "클리닉", "요양원", "보건소", "학원", "학교", "유치원", "어린이집", "법원",
  "센터", "식당", "레스토랑", "카페", "커피", "베이커리", "빵집", "꽃집", "가게", "상점", "매장", "마트", "편의점", "백화점",
  "호텔", "모텔", "펜션", "미용실", "사무실", "사무소", "연구소", "세탁소", "정비소", "주유소", "파출소", "부동산", "은행",
  "우체국", "경찰서", "소방서", "세무서", "구청", "시청", "군청", "도청", "사진관", "영화관", "도서관", "대사관", "체육관",
  "헬스장", "공장", "주차장", "스튜디오", "공방", "서점", "극장", "회사", "여행사", "보험사", "카드사", "통신사", "항공사",
  "택배", "협회", "재단", "주식회사", "\\(주\\)", "[가-힣A-Za-z0-9]{2,}\\s?[가-힣]{0,6}점",
];
const PLACE_RE = new RegExp(`(?:${PLACE_ENDINGS.join("|")})$|\\b(?:inc|corp|co|llc|ltd|clinic|hospital|dental|pharmacy|center|centre|cafe|café|restaurant|hotel|store|shop|salon|bank|office)\\.?$`, "i");

type Callee = "person" | "place" | "meeting" | "number";

/** who the call is to: a person (honorific), a place or a meeting line (named, no 님), or a bare number */
function callee(a: PhoneArgs): Callee {
  const n = typeof a.name === "string" ? a.name.trim().replace(/님$/, "").trim() : "";
  if (!n) return "number";
  if (isMeeting(a)) return "meeting";
  return PLACE_RE.test(n) ? "place" : "person";
}

function who(a: PhoneArgs, masked: string): string {
  const n = typeof a.name === "string" ? a.name.trim().replace(/님$/, "").trim() : "";
  const k = callee(a);
  return k === "number" ? masked : k === "person" ? `${n}님` : n;
}

/** the particle after `who()`: "께" for a person only ("단아님께"), "에" for a place, a meeting line or a number */
function ke(a: PhoneArgs): string {
  return callee(a) === "person" ? "께" : "에";
}

/** "단아님께 전화" / "연세바른치과에 전화" / "relay daily 회의 전화 참여" */
function callTitle(a: PhoneArgs, target: string): string {
  return isMeeting(a) ? `${target} 전화 참여` : `${target}${ke(a)} 전화`;
}

const DIGITS_PARAM = {
  type: "string" as const,
  description:
    "Keys to press after the call connects, e.g. a meeting dial-in PIN ending in '#' (Google Meet: '463394124#') or an extension. Digits, '*', '#' and 'w' (half-second wait) only. Omit for normal calls.",
};

export function phoneTool(core: Core): ToolDef<PhoneArgs> {
  return {
    name: "sys_phone_call",
    description:
      "Place an outbound phone call to SOMEONE ELSE on the user's behalf and speak a short Korean message with text-to-speech. Use ONLY when the user explicitly asks you to call another person or a meeting line. `to` is a phone number (E.164 like +821012345678 or Korean 010-1234-5678). Call this tool directly when asked: the app shows the user a confirmation card and dials only after they approve, so never ask for confirmation in chat first. To call the user themselves (\"나한테 전화해줘\", wake-up or reminder calls), use sys_call_me instead.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Phone number to call (E.164 or Korean format)" },
        message: { type: "string", description: "What to say, in Korean, at most 300 characters" },
        name: { type: "string", description: "Recipient's name, e.g. '단아' or a meeting name like 'relay daily 회의' (optional)" },
        digits: DIGITS_PARAM,
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
    icon: "phone-out",
    timeoutMs: PHONE_TOOL_TIMEOUT_MS,
    title: (a) => {
      const n = normalizePhone(a?.to ?? "");
      const args = a ?? { to: "", message: "" };
      return callTitle(args, who(args, n ? maskPhone(n) : "상대방"));
    },
    approval: (a) => {
      const n = normalizePhone(a.to);
      const target = who(a, n ? maskPhone(n) : String(a.to).slice(0, 20));
      const d = normalizeDigits(a.digits);
      const keys = d ? d.replace(/w/g, "") : "";
      const press = keys ? `연결되면 ${keys}을 누른 뒤 ` : "";
      const message = String(a.message ?? "").slice(0, 300);
      const name = typeof a.name === "string" && a.name.trim() ? who(a, "") : null;
      return {
        // title / detail are what the model's history and the logs carry: masked
        title: isMeeting(a) ? `${target}에 전화로 참여할까요?` : `${target}${ke(a)} 전화할까요?`,
        detail: `${n ? maskPhone(n) : "번호 확인 필요"}로 전화해서 ${press}이렇게 전할게요: “${message}”`,
        // the card alone shows the full number, so the person can check it before approving
        call: { target: name, number: n ? formatPhone(n) : null, message, ...(keys ? { digits: keys } : {}) },
      };
    },
    async run(a: PhoneArgs, ctx: ToolContext): Promise<ToolResult> {
      const to = normalizePhone(a.to);
      if (!to) return { ok: false, summary: "전화번호 형식이 올바르지 않아요", data: { error: "invalid_number" } };
      const m = checkMessage(a.message, a.digits);
      if ("ok" in m) return m;
      const target = who(a, maskPhone(to));
      return callWithThread(core, ctx, { to, ...m, title: callTitle(a, target), target, ke: ke(a) });
    },
  };
}

export function callMeTool(core: Core): ToolDef<CallMeArgs> {
  return {
    name: "sys_call_me",
    description:
      "Call the USER'S OWN phone (the number they verified in 나의 모시 > 내 전화번호) and speak a short Korean message with text-to-speech. Use it whenever the user asks to be called themselves: \"나한테 전화해줘\", \"내 폰으로 전화해줘\", wake-up calls (\"매일 7시에 전화로 깨워줘\"), reminder calls. It needs no approval and works inside scheduled tasks, so for a recurring wake-up/reminder call create a schedule whose prompt asks you to call the user with this tool. There is no number argument: it always calls the user's own verified number. Use sys_phone_call only for OTHER people's numbers. At most 10 calls a day.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to say, in Korean, at most 300 characters (e.g. a wake-up greeting with today's weather)" },
        digits: DIGITS_PARAM,
      },
      required: ["message"],
      additionalProperties: false,
    },
    icon: "phone-out",
    timeoutMs: PHONE_TOOL_TIMEOUT_MS,
    title: () => "내 휴대폰으로 전화",
    async run(a: CallMeArgs, ctx: ToolContext): Promise<ToolResult> {
      const mine = readMyPhone(core, ctx.userId);
      if (!mine || mine.verifiedAt === null) return { ok: false, summary: CALL_ME_NOT_VERIFIED, data: { error: "phone_not_verified" } };
      const m = checkMessage(a?.message, a?.digits);
      if ("ok" in m) return m;
      if (core.cfg.twilio && !takeCallMeSlot(core, ctx.userId)) {
        return {
          ok: false,
          summary: `오늘은 내 휴대폰으로 더 전화할 수 없어요 (하루 ${CALL_ME_DAILY_LIMIT}번까지)`,
          data: { error: "daily_limit", limit: CALL_ME_DAILY_LIMIT },
        };
      }
      return callWithThread(core, ctx, { to: mine.e164, ...m, title: "내 휴대폰으로 전화", target: "내 휴대폰", ke: "으로" });
    },
  };
}

/** Every phone tool, for buildTools (never in friend threads). */
export function phoneTools(core: Core): ToolDef[] {
  return [phoneTool(core) as unknown as ToolDef, callMeTool(core) as unknown as ToolDef];
}
