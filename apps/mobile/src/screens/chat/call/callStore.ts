import type { ID } from "@pickle/protocol";
import { island, islandStore } from "../../../app/island";
import { isTurnRunning, messagesStore, reportHeard, sendMessage, sessionStore, stopTurn, type SendResult } from "../../../api/store";
import { dropStoppedSteers, failedTurnSteers } from "../composerStore";
import { createMic, createRecognizer, speechSupport, type Mic, type Recognizer } from "./speech";
import { isEcho, speakable, speechCutter, type SpeechCutter } from "./speechText";
import { audioContext, unlockAudio } from "./audioUnlock";
import { callStore, IDLE_CALL, PHASE_TEXT, type CallLine } from "./callState";
import { canSpeak, closeVoice, openReply, stopVoice, type ReplyVoice, type SpeakOutcome } from "./voice";
import { holdMsFrom, lineHold } from "./lineHold";

export { callStore, PHASE_TEXT, useCall, type CallLine, type CallPhase, type CallState } from "./callState";

/**
 * A voice call with the agent (MOTION-SPEC §6.10, research §3-6 / §4-10).
 *   startCall(threadId): the composer's call circle stretches into the Dynamic Island, which grows into the call card.
 *   Mic → real input level (AnalyserNode, ~30 Hz, 0.1 s smoothing) drives the blob, the island's dots and agentState.
 *   Web Speech STT (ko-KR) → a line that looks unfinished ("내일 회의 자료를") waits up to 1.5 s after the last speech
 *   for the rest, 10 s at most (lineHold.ts) → sendMessage(…, {mode:"voice"}) → the agent's reply is spoken WHILE it
 *   streams: its draft is cut into pieces (speechText.ts speechCutter: the first sentence, or a long one's first
 *   clause, then whole sentences) that the server voice says in order (voice.ts: /api/tts/stream, /api/tts sentence
 *   by sentence, Web Speech ko-KR as the fallbacks). The done message is checked against what was said: the rest is
 *   said, or — if it no longer starts with what was said — the voice stops (short fade) and nothing is said twice.
 *   Listening resumes after the reply.
 *   The recogniser keeps listening the whole time:
 *     - before the reply's first audio, the person talking holds the voice back (nothing was heard, so it starts over
 *       from the first piece once they are done), and a line they finish while the turn still runs is steered into it
 *       (202: the same turn answers both, in the same draft — no second reply); once that turn has ended, their line is
 *       a turn of its own, answered after the reply nobody has heard yet (which is said first, not dropped);
 *     - after it, the person talking (not the agent's own echo), typing, mute or speaker off cut the voice off at once
 *       (barge-in); talking or typing also stops the turn, and their line starts a new one. What they heard of each
 *       reply cut off that way (whole words; nothing of the ones still waiting) goes to the server (POST …/heard), so
 *       the reply's history keeps only that, and their line waits for it (≤ 1 s) before it is sent. Mute and speaker
 *       off report nothing: the reply goes on in the transcript, where it is read.
 *   The blob and level follow the voice's real output level while it plays.
 *   Missing APIs degrade honestly: no STT → type to talk; no voice at all → read the reply.
 * The timer starts only once connected (mic ready or the fallback chosen) — never during "연결 중".
 */
let mic: Mic | null = null;
let rec: Recognizer | null = null;
/** the recogniser is running (started, no final / end / fatal error since) */
let recOn = false;
let seq = 0;
let session = 0;
/** recogniser errors in a row (network / audio-capture) — two and the call falls back to typing */
let sttFailures = 0;
/** the listening session whose words count (recognize()). A mute ends it: a result still on its way (a recogniser
 *  finalises what it was hearing when it stops) is dropped, and unmuting starts a new one, so nothing heard before or
 *  around the mute reaches the agent */
let hearing = 0;
/** the "me" line of words still being heard (interim, or a held line being merged with the rest), until final */
let hearingLine: string | null = null;
/** true while we push our own state into the island (its subscriber must not echo it back) */
let linking = false;

const lineId = () => `l${++seq}`;
function pushLine(l: Omit<CallLine, "id">): string {
  const id = lineId();
  callStore.patch({ lines: [...callStore.get().lines.slice(-20), { ...l, id }] });
  return id;
}
function patchLine(id: string, patch: Partial<CallLine>) {
  callStore.patch({ lines: callStore.get().lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
}

function setLevel(v: number) {
  const s = callStore.get();
  const level = s.muted ? 0 : v;
  if (Math.abs(level - s.level) < 0.015) return;
  callStore.patch({ level });
  island.updateCall({ amplitude: level });
}

/** the mic level drives the blob except while the agent speaks (then the voice's output level does) */
function micLevel(v: number) {
  if (callStore.get().phase !== "speaking") setLevel(v);
}

/** what the agent is saying (every piece handed to the voice): the barge-in echo guard compares against it */
let speakingText = "";

// ── the reply ──

/**
 * The reply the call is waiting for or speaking — one at a time. Its streaming draft is cut into pieces (speechCutter);
 * the pieces go to the voice as soon as nobody is talking over it.
 */
interface Reply {
  threadId: ID;
  /** its transcript line */
  line: string;
  /** the draft already there when it was sent (a stopped turn winding down): not this reply's */
  before: ID | null;
  /** this reply's draft, once it appeared */
  messageId: ID | null;
  cutter: SpeechCutter;
  /** every piece cut so far, in order; `given` of them went to the current voice */
  pieces: string[];
  given: number;
  voice: ReplyVoice | null;
  /** its first audio was scheduled: from now on the person talking is a barge-in */
  heard: boolean;
  /** the turn is over (done, failed or stopped) */
  over: boolean;
  /** nothing more is said (cut off, mute, speaker off, or the done text no longer starts with what was said) */
  silent: boolean;
  /** its transcript line as it should read: shown (pushed) when it becomes the call's reply, patched from then on */
  view: Pick<CallLine, "who" | "text" | "final">;
  /** the draft last fed to the cutter (closed flag + text) */
  fed: string;
}
let reply: Reply | null = null;
/** replies to lines said before anything of `reply` was heard, once its turn had ended: said after it, in order */
let queue: Reply[] = [];
/** lines being steered into a running turn: nothing unheard is said until they are in */
let steering = 0;

function newReply(threadId: ID): Reply {
  return {
    threadId,
    line: "",
    before: messagesStore.get()[threadId]?.draft?.messageId ?? null,
    messageId: null,
    cutter: speechCutter(),
    pieces: [],
    given: 0,
    voice: null,
    heard: false,
    over: false,
    silent: false,
    view: { who: "agent", text: "", final: false },
    fed: "",
  };
}

/** a new turn's reply becomes the call's: its line appears and the call thinks */
function adopt(r: Reply) {
  reply = r;
  r.line = pushLine({ ...r.view });
  callStore.patch({ phase: "thinking" });
}

/** its transcript line reads `patch` (kept for later while it waits behind an earlier reply) */
function show(r: Reply, patch: Partial<Reply["view"]>) {
  Object.assign(r.view, patch);
  if (r.line) patchLine(r.line, patch);
}

/** the next waiting reply becomes the call's once the one before it is over and said */
function promote(): boolean {
  const r = queue.shift();
  if (!r) return false;
  adopt(r);
  speakingText = r.cutter.said();
  if (r.silent) settle(r);
  else pump(r);
  return true;
}

/** the person is talking (an interim result since their last final): a reply not heard yet waits for them */
let talking = false;
let talkTimer: ReturnType<typeof setTimeout> | undefined;
/** a recogniser that hangs with neither a final nor an end can't hold a reply back for longer than this */
const TALK_MAX_MS = 6000;
function setTalking(on: boolean) {
  clearTimeout(talkTimer);
  if (on) talkTimer = setTimeout(() => setTalking(false), TALK_MAX_MS);
  if (talking === on) return;
  talking = on;
  gateChanged();
}

/** a reply nobody has heard yet waits while the person talks, a line of theirs is held, or a steer is on its way */
const waiting = (r: Reply) => !r.heard && (talking || !!hold.held() || steering > 0);

function gateChanged() {
  const r = reply;
  if (!r || r.silent) return;
  if (!waiting(r)) return pump(r);
  if (r.voice) {
    // nothing of it was heard: drop the voice, it starts again from the first piece once the person is done
    r.voice = null;
    r.given = 0;
    stopVoice();
    callStore.patch({ voice: null });
  }
}

/** hand the reply's new pieces to its voice (opening one once there is something to say and nobody to wait for) */
function pump(r: Reply) {
  if (r !== reply || r.silent || waiting(r)) return;
  if (!r.voice) {
    if (!r.pieces.length) return settle(r);
    if (!callStore.get().speaker || !canSpeak()) {
      r.silent = true;
      return settle(r);
    }
    const v = openReply({
      onLevel: (x) => reply === r && setLevel(x),
      onVoice: (voice) => reply === r && callStore.patch({ voice }),
      onPlaying: (on) => playing(r, on),
    });
    r.voice = v;
    r.given = 0;
    void v.outcome.then((o) => voiceDone(r, v, o));
  }
  const v = r.voice;
  while (r.given < r.pieces.length) v.push(r.pieces[r.given++]!);
  if (r.over) v.end();
}

function playing(r: Reply, on: boolean) {
  if (r !== reply) return;
  if (on) r.heard = true;
  const s = callStore.get();
  // between pieces (a tool running before the rest of the answer) the call thinks again
  if (on || !r.over) callStore.patch({ phase: s.muted && !on ? "paused" : on ? "speaking" : "thinking" });
}

function voiceDone(r: Reply, v: ReplyVoice, o: SpeakOutcome) {
  if (r.voice !== v) return; // dropped for the person talking, or cut off
  r.voice = null;
  // cut off (barge-in, mute, speaker off): whoever stopped it already decided what comes next
  if (o === "stopped") return;
  settle(r);
}

/** the reply is over and said (or there was nothing to say): the person's turn */
function settle(r: Reply) {
  if (r !== reply || !r.over || r.voice) return;
  reply = null;
  speakingText = "";
  callStore.patch({ voice: null });
  if (!promote()) listen();
}

/** the person cut in (talking over the voice, typing): the voice stops at once, the turn too, and every reply
 * waiting behind it goes; the turn is theirs. What they heard of each goes to its history (a reply silenced before,
 * by mute or speaker off, was left to the transcript: it keeps its text). */
function bargeIn() {
  for (const r of reply ? [reply, ...queue] : [...queue]) {
    if (!r.silent) heard(r, r.voice ? r.voice.heard() : "");
    cutOff(r);
  }
  queue = [];
  callStore.patch({ phase: "listening", voice: null });
  setLevel(0);
}

/** heard reports on their way: the person's next line waits for them (HEARD_WAIT_MS at most) */
let heardReports: Promise<void>[] = [];
const HEARD_WAIT_MS = 1000;
function heard(r: Reply, text: string) {
  if (!r.messageId) return; // its draft never appeared: nothing of it was said, nothing is stored yet
  const p = reportHeard(r.threadId, r.messageId, text).catch(() => {});
  heardReports.push(p);
  void p.then(() => (heardReports = heardReports.filter((x) => x !== p)));
}
async function heardIn() {
  if (!heardReports.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(heardReports), new Promise<void>((res) => (timer = setTimeout(res, HEARD_WAIT_MS)))]);
  clearTimeout(timer);
}

/** `stop`: its turn is stopped too when it still runs (not when the server already ended it) */
function cutOff(r: Reply, stop = true) {
  r.silent = true;
  if (reply === r) reply = null;
  queue = queue.filter((q) => q !== r);
  if (r.voice) {
    r.voice = null;
    stopVoice();
  }
  speakingText = "";
  if (stop && !r.over && isTurnRunning(r.threadId)) stopTurn(r.threadId);
  show(r, { final: true });
}

/** say nothing more of it (mute, speaker off, or a done text that diverged); its turn goes on into the transcript */
function silence(r: Reply, fadeMs = 0) {
  r.silent = true;
  if (r.voice) {
    r.voice = null;
    stopVoice(fadeMs);
  }
  if (reply === r) {
    speakingText = "";
    callStore.patch({ voice: null });
  }
  settle(r);
}

function cut(r: Reply, pieces: string[]) {
  if (r.cutter.diverged()) {
    // the reply no longer starts with what was said: stop cleanly, and never say any of it again
    if (!r.silent) silence(r, 60);
    return;
  }
  if (!pieces.length || r.silent) return;
  r.pieces.push(...pieces);
  if (reply === r) speakingText = r.cutter.said();
  pump(r);
}

/** the call's replies follow their drafts as they stream (the store flushes text deltas once per frame) */
function onDraft() {
  for (const r of reply ? [reply, ...queue] : [...queue]) if (!r.over) follow(r);
  steerFailed();
}

/** lines a turn from elsewhere took (202, "하던 일에 이어서 전했어요"), by their message id, until it answers or fails */
const steerNotes = new Map<ID, Reply>();
/**
 * That turn failed (the thread's error row, ThreadView's rule): the lines it left unanswered read its error in place of
 * the note, which would read as handled.
 */
function steerFailed() {
  const threadId = callStore.get().threadId;
  const t = threadId && steerNotes.size ? messagesStore.get()[threadId] : undefined;
  const error = t?.error;
  if (!error) return;
  for (const id of failedTurnSteers(t, (x) => steerNotes.has(x))) {
    show(steerNotes.get(id)!, { text: error, final: true, who: "note" });
    steerNotes.delete(id);
  }
}
function follow(r: Reply) {
  const d = messagesStore.get()[r.threadId]?.draft;
  if (!d) return;
  if (!r.messageId) {
    if (d.messageId === r.before) return;
    r.messageId = d.messageId;
  } else if (d.messageId !== r.messageId) return;
  // a tool running (or waiting for approval): the text so far is all the model says before it
  const closed = d.tools.some((t) => t.state === "running" || t.state === "needs_approval");
  const key = `${closed ? 1 : 0}${d.text}`;
  if (key === r.fed) return;
  r.fed = key;
  if (d.text) show(r, { text: speakable(d.text) });
  if (!r.silent) cut(r, r.cutter.feed(d.text, closed));
}
let unsubDraft: (() => void) | null = null;

/**
 * A whole line from the person (spoken and released by the hold, or typed). Said before anything of the call's reply
 * was heard, it goes on with what they said: a steer into the newest turn while that still runs (the same request,
 * continued), or else a turn of its own answered after the replies already on their way. Said after the first audio
 * (or with nothing on its way) it is a new turn, and whatever was speaking or waiting is cut off.
 */
async function send(text: string): Promise<void> {
  const s = callStore.get();
  const body = text.trim();
  if (!s.active || !s.threadId || !body) return;
  const threadId = s.threadId;
  const my = session;
  const chain = reply && reply.threadId === threadId ? [reply, ...queue] : [];
  const last = chain.at(-1) ?? null;
  // nothing of the call's reply was heard yet: the person is going on with what they said
  const unheard = !!reply && !!last && !reply.heard && !reply.silent;
  const into = unheard && last && !last.over && !last.silent && isTurnRunning(threadId) ? last : null;
  if (chain.length && !unheard) bargeIn();
  const mine = newReply(threadId);
  let pending = !!into;
  const settled = () => {
    if (!pending) return;
    pending = false;
    steering--;
  };
  if (into) steering++;
  else if (unheard) queue.push(mine);
  else adopt(mine);
  // a turn of its own: what was heard of the replies cut off is in their history first
  if (!into) await heardIn();
  let late = false;
  const r = await sendMessage(threadId, body, {
    mode: "voice",
    onAccepted: (kind) => {
      if (!into || !pending) return;
      settled();
      if (kind === "stream" && callStore.get().active && my === session) {
        // the running turn ended in between: this line is a turn of its own, answered after the reply on its way
        late = true;
        if (reply) queue.push(mine);
        else adopt(mine);
      }
      gateChanged();
    },
  });
  // the call's own turn came back stopped (cut off by the person talking over it, or 멈추기 in the thread's composer
  // with the call folded): lines steered into it from the thread lose "하던 일에 이어서 전했어요", as in ThreadView
  dropStoppedSteers(r, messagesStore.get()[threadId]?.items ?? []);
  // the steer is in (or refused, or the call ended meanwhile): it holds nothing back any more
  settled();
  if (my !== session || !callStore.get().active) return;
  if (into && !late) {
    if (!r.ok && r.status !== "aborted") pushLine({ who: "note", text: r.error.message, final: true });
    gateChanged();
    return;
  }
  finishTurn(mine, r);
}

/** the turn's end: the reply's last pieces (checked against the done text), or the reason it has none */
function finishTurn(r: Reply, res: SendResult) {
  r.over = true;
  if (r !== reply && !queue.includes(r)) return; // cut off meanwhile
  if (res.ok && (res.steered || res.delivered)) {
    // a turn from elsewhere was running in this thread: it took the line
    show(r, { text: "하던 일에 이어서 전했어요", final: true, who: "note" });
    r.silent = true;
    if (res.steered && res.message) steerNotes.set(res.message.id, r);
    steerFailed(); // that turn may have failed before the 202 got here
    return settle(r);
  }
  if (!res.ok) {
    // what was said stays said; the partial's unfinished last sentence is not cut
    if (r.cutter.said()) {
      show(r, { final: true });
      pushLine({ who: "note", text: res.error.message, final: true });
    } else {
      show(r, { text: res.error.message, final: true, who: "note" });
      r.silent = true;
    }
    return r.silent ? settle(r) : pump(r);
  }
  const text = res.message?.role === "assistant" ? res.message.text : "";
  show(r, { text: speakable(text) || "말할 내용이 없어요", final: true });
  if (!r.silent) cut(r, r.cutter.feed(text, true, true));
  if (r.silent) settle(r);
  else pump(r);
}

// ── listening ──

/** the line being held for the rest (the transcript keeps it as one line), if any */
let heldLine: string | null = null;

/** an unfinished line waits for the rest (lineHold.ts); VITE_CALL_HOLD_MS sets the wait (default 1.5 s, 0 = off) */
const hold = lineHold({
  holdMs: holdMsFrom(import.meta.env.VITE_CALL_HOLD_MS),
  send: (text) => void send(text),
  onChange: (held) => {
    if (!held) heldLine = null;
    gateChanged();
  },
});

function listen() {
  const s = callStore.get();
  if (!s.active) return;
  callStore.patch({ phase: s.muted ? "paused" : "listening" });
  if (!recOn) recognize();
}

/** the recogniser listens in every phase but "paused" / "connecting": the person's turn, the reply's wait, its voice */
const watching = () => {
  const p = callStore.get().phase;
  return p === "listening" || p === "thinking" || p === "speaking";
};
function relisten(ms: number) {
  const my = session;
  setTimeout(() => my === session && !recOn && watching() && recognize(), ms);
}

function recognize() {
  const s = callStore.get();
  if (!s.active || s.muted || !rec) return;
  const mine = ++hearing;
  /** this session's results count only while it is the call's and the mic is open */
  const live = () => mine === hearing && !callStore.get().muted;
  /** this session's line in the transcript (or the held line it goes on with) */
  let line: string | null = null;
  recOn = true;
  rec.start({
    onInterim: (text) => {
      if (!live()) return;
      sttFailures = 0;
      const r = reply;
      if (r?.heard && !r.silent) {
        if (isEcho(text, speakingText)) return;
        bargeIn();
      }
      setTalking(true);
      hold.interim();
      const held = hold.held();
      const shown = held ? `${held} ${text}` : text;
      line ??= heldLine ?? pushLine({ who: "me", text: shown, final: false });
      hearingLine = line;
      patchLine(line, { text: shown, final: false });
    },
    onFinal: (text) => {
      if (!live()) return;
      sttFailures = 0;
      recOn = false;
      const r = reply;
      if (r?.heard && !r.silent) {
        if (isEcho(text, speakingText)) {
          setTalking(false);
          return relisten(250);
        }
        bargeIn();
      }
      const held = hold.held();
      const id = line ?? heldLine ?? pushLine({ who: "me", text, final: true });
      line = hearingLine = null;
      patchLine(id, { text: held ? `${held} ${text}` : text, final: true });
      heldLine = id;
      hold.final(text);
      setTalking(false);
      relisten(60);
    },
    onEnd: () => {
      if (mine !== hearing) return;
      // silence or a recogniser timeout: listen again while the call is still watching
      recOn = false;
      setTalking(false);
      const cur = callStore.get();
      if (cur.active && !cur.muted && watching()) relisten(250);
    },
    onError: (code) => {
      if (mine !== hearing) return;
      if (code === "not-allowed" || code === "service-not-allowed") {
        callStore.patch({ error: "마이크를 쓸 수 없어요. 브라우저 설정에서 마이크를 허용해 주세요.", support: { ...callStore.get().support, stt: false } });
        rec?.abort();
        rec = null;
        recOn = false;
        return;
      }
      if (code === "no-speech" || code === "aborted") return;
      // network / audio-capture / start-failed: retrying forever would spin; after two in a row, fall back to typing
      if (++sttFailures >= 2) {
        rec?.abort();
        rec = null;
        recOn = false;
        callStore.patch({ support: { ...callStore.get().support, stt: false } });
        pushLine({ who: "note", text: "음성 인식이 연결되지 않아요 · 글자로 말할 수 있어요", final: true });
      }
    },
  });
}

/** A line typed in the fallback (with whatever spoken line is held joined to it): a voice-mode turn. */
export async function say(text: string): Promise<void> {
  if (!text.trim()) return;
  hold.flush(text);
}

/** where the call was started from (the composer's call circle): the card stretches out of it once */
let callSource: DOMRect | null = null;
export function takeCallSource(): DOMRect | null {
  const r = callSource;
  callSource = null;
  return r;
}

/** launch.ts calls this (the tap already unlocked the audio); `source` is the call circle the card stretches out of */
export async function startCall(threadId: ID, source?: HTMLElement | DOMRect | null) {
  // inside a gesture this resumes the context; after one (the lazy chunk arriving) it is harmless
  unlockAudio();
  callSource = source ? ("getBoundingClientRect" in source ? source.getBoundingClientRect() : source) : null;
  const cur = callStore.get();
  if (cur.active) {
    callStore.patch({ open: true });
    return;
  }
  const my = ++session;
  sttFailures = 0;
  recOn = false;
  unsubDraft ??= messagesStore.subscribe(onDraft);
  const support = { ...speechSupport(), tts: canSpeak() };
  callStore.set({ ...IDLE_CALL, active: true, open: true, threadId, phase: "connecting", support, lines: [] });
  // connect: ask for the mic only now (first need), never during onboarding. A permission prompt left open must not
  // hold the call at "연결 중": after MIC_WAIT_MS it connects with the typed fallback and the mic joins when granted.
  let micOk = false;
  let micPending: Promise<Mic> | null = null;
  if (support.mic) {
    const got = createMic(micLevel, audioContext());
    const first = await Promise.race([
      got.then(
        (m) => ({ m }) as const,
        (e: unknown) => ({ e }) as const,
      ),
      new Promise<null>((r) => setTimeout(() => r(null), MIC_WAIT_MS)),
    ]);
    if (first === null) micPending = got;
    else if ("m" in first) {
      mic = first.m;
      micOk = true;
    } else callStore.patch({ error: micError(first.e) });
  }
  if (my !== session) {
    mic?.stop();
    void micPending?.then((m) => m.stop(), () => {});
    return;
  }
  rec = micOk && support.stt ? createRecognizer() : null;
  const name = sessionStore.get().session?.agent.name ?? "깽이";
  const startedAt = Date.now();
  callStore.patch({ phase: "listening", startedAt, support: { ...support, mic: micOk, stt: !!rec } });
  linking = true;
  island.call({ name, startedAt });
  island.updateCall({ expanded: false, speaker: true, muted: false, status: PHASE_TEXT.listening });
  linking = false;
  if (micPending) {
    const waiting = pushLine({ who: "note", text: "마이크 허용을 기다리고 있어요 · 그동안 글자로 말할 수 있어요", final: true });
    void micPending.then(
      (m) => attachMic(m, my, waiting),
      (e: unknown) => my === session && callStore.patch({ error: micError(e) }),
    );
  } else if (!rec) pushLine({ who: "note", text: "음성 인식을 쓸 수 없어서 글자로 말할 수 있어요", final: true }); // with STT the phase line says it
  listen();
}

const MIC_WAIT_MS = 2500;

function micError(e: unknown): string {
  const n = (e as DOMException)?.name;
  return n === "NotAllowedError" || n === "SecurityError" ? "마이크를 쓸 수 없어요. 브라우저 설정에서 마이크를 허용해 주세요." : "마이크를 찾지 못했어요. 글자로 말할 수 있어요.";
}

/** the permission was granted after the call connected: the mic (and speech recognition) join the running call; the
 * waiting note goes (the status line already says "듣고 있어요"), or, with no speech recognition, says typing is the way */
function attachMic(m: Mic, my: number, waiting: string) {
  if (my !== session || !callStore.get().active) return m.stop();
  mic = m;
  const s = callStore.get();
  m.setMuted(s.muted);
  rec = s.support.stt || speechSupport().stt ? createRecognizer() : null;
  callStore.patch({ support: { ...s.support, mic: true, stt: !!rec }, ...(rec ? { lines: callStore.get().lines.filter((l) => l.id !== waiting) } : {}) });
  if (!rec) patchLine(waiting, { text: "음성 인식을 쓸 수 없어서 글자로 말할 수 있어요" });
  if (callStore.get().phase === "listening") listen();
}

export function setCallOpen(open: boolean) {
  if (!callStore.get().active) return;
  callStore.patch({ open });
  linking = true;
  island.updateCall({ expanded: false, held: false });
  linking = false;
}

export function toggleMute() {
  const s = callStore.get();
  if (!s.active) return;
  const muted = !s.muted;
  callStore.patch({ muted, phase: muted ? "paused" : s.phase === "paused" ? "listening" : s.phase });
  linking = true;
  island.updateCall({ muted });
  linking = false;
  mic?.setMuted(muted);
  if (muted) {
    // mute cuts the agent off as well (barge-in) while it speaks; its turn goes on into the transcript
    if (reply?.heard && !reply.silent) {
      for (const q of queue) q.silent = true;
      silence(reply);
    }
    // and it is private at once: the words still being heard are dropped, not finalised and sent (stop() would), a line
    // held for the rest (or being merged with it) is dropped too, and their lines leave the transcript; unmuting
    // listens afresh (a new session, no line carried over)
    hearing++;
    rec?.abort();
    recOn = false;
    setTalking(false);
    const gone = new Set([hearingLine, heldLine].filter((id): id is string => !!id));
    hearingLine = null;
    hold.drop();
    heldLine = null;
    if (gone.size) callStore.patch({ lines: callStore.get().lines.filter((l) => !gone.has(l.id)) });
    setLevel(0);
  } else if (callStore.get().phase === "listening") listen();
}

export function toggleSpeaker() {
  const s = callStore.get();
  if (!s.active) return;
  const speaker = !s.speaker;
  callStore.patch({ speaker });
  linking = true;
  island.updateCall({ speaker });
  linking = false;
  if (speaker) unlockAudio();
  else if (reply && !reply.silent) {
    // the reply stops speaking (the transcript goes on), and so do those waiting behind it; the call thinks until its
    // turn is over
    const r = reply;
    for (const q of queue) q.silent = true;
    silence(r);
    if (reply === r && callStore.get().phase === "speaking") callStore.patch({ phase: "thinking" });
  }
}

export function endCall() {
  const s = callStore.get();
  if (!s.active) return;
  session++;
  if (reply) reply.silent = true;
  for (const q of queue) q.silent = true;
  reply = null;
  queue = [];
  steering = 0;
  steerNotes.clear();
  heardReports = [];
  hearing++;
  hearingLine = null;
  rec?.abort();
  rec = null;
  recOn = false;
  mic?.stop();
  mic = null;
  hold.drop();
  setTalking(false);
  heldLine = null;
  speakingText = "";
  unsubDraft?.();
  unsubDraft = null;
  closeVoice();
  callStore.patch({ active: false, open: false, phase: "ended", level: 0, voice: null });
  linking = true;
  if (islandStore.get().call) island.endCall();
  linking = false;
}

// the island's own end button (the long-pressed island) ends our call too; its mute mirrors ours
islandStore.subscribe(() => {
  const c = islandStore.get().call;
  const s = callStore.get();
  if (linking || !s.active || s.phase === "connecting") return;
  if (!c) return endCall();
  if (c.muted !== s.muted) toggleMute();
  if (c.speaker !== s.speaker) toggleSpeaker();
  // a tap on the island brings the card back (with the card up it changes nothing); a long-press (held) grows the
  // island in place with mute and end, only while the card is closed
  if (c.expanded && (s.open || !c.held)) {
    linking = true;
    island.updateCall({ expanded: false, held: false });
    linking = false;
    if (!s.open) callStore.patch({ open: true });
  }
});
// the long-pressed island says what the call is doing ("듣고 있어요 · 00:05"), as the card does under the character
callStore.subscribe(() => {
  const c = islandStore.get().call;
  const s = callStore.get();
  if (!s.active || !c || c.status === PHASE_TEXT[s.phase]) return;
  linking = true;
  island.updateCall({ status: PHASE_TEXT[s.phase] });
  linking = false;
});

export const activeCallThread = () => (callStore.get().active ? callStore.get().threadId : null);
