import type { IconName } from "@pickle/protocol";
import { createStore, useStore } from "../lib/createStore";
import { toolLabel } from "./agentVocab";

/**
 * The agent-state store (MOTION-SPEC §8.3, research §3-0): ONE vocabulary shared by the Dynamic Island, the composer
 * (send ↔ stop), tool chips and the screen-reader live region (<AgentLive/>). Plus the island's banner queue.
 *
 *   idle · listening · thinking · tool:<name> · streaming · awaiting_approval · done · error · offline · call
 *
 *   island.listening(); island.micLevel(0..1)      // real mic input level → level bars
 *   island.thinking(threadId)                      // after send, before the first token ("생각하는 중" after 1 s)
 *   island.tool("k_weather")                       // label from the real tool name → "날씨 보는 중"
 *   island.tokens(n)                               // streamed text → "streaming", level bars = token rate
 *   island.awaitingApproval("메일 보내기")
 *   island.done()                                  // drawn check, then idle after 1.6 s
 *   island.error() · island.idle() · island.event() (any server event: resets the 15 s stall clock)
 *   island.setHandlers({ stop, retry, open })      // what tapping the island does (멈추기 / 다시 시도 / open thread)
 *   island.call({ name }) · island.banner({...}) · island.undo({...})
 *
 * Rules: idle is STILL (nothing animates); level is 0 unless a real value feeds it; after 2 s in the same state
 * `elapsed` (whole seconds) is set; after 15 s without events while busy `stalled` is set ("오래 걸리고 있어요 ·
 * 멈추기", not an error). Never claims success before the server does: call done() only on a server event.
 */
export type AgentKind =
  | "idle"
  | "listening"
  | "thinking"
  | "tool"
  | "streaming"
  | "awaiting_approval"
  | "done"
  | "error"
  | "offline"
  | "call";
export type AgentState = Exclude<AgentKind, "tool"> | `tool:${string}`;

/** a turn is running (composer shows Stop, island is wide) */
export const isBusy = (k: AgentKind) => k === "thinking" || k === "tool" || k === "streaming";

export interface IslandCall {
  name: string;
  startedAt: number;
  muted: boolean;
  speaker: boolean;
  expanded: boolean;
  /** expanded by a long-press on the pill (mute and end in place), not a request for the call card */
  held?: boolean;
  /** what the call is doing, for the expanded island ("듣고 있어요") */
  status?: string;
  /** 0..1 live voice amplitude (agent speaking) */
  amplitude: number;
}

export interface IslandBanner {
  id: number;
  icon: IconName;
  title: string;
  body?: string;
  /** "지금" by default */
  meta?: string;
  /** "error" banners use role=alert and contract into a red dot back into the island (`kind: "error"` is the same) */
  tone?: "default" | "error";
  /** FOUNDATION-NEXT spelling: "info" (default) | "error" | "undo" */
  kind?: "info" | "error" | "undo";
  onPress?: () => void;
  /** one action button on the right (e.g. 실행 취소) — pressing it runs onPress and dismisses */
  action?: { label: string; onPress?: () => void; run?: () => unknown };
  /** ms the banner holds; default clamp(1.5 s + 60 ms × characters, 2–4 s) */
  hold?: number;
  /** called when the banner leaves without its action being pressed */
  onExpire?: () => void;
  /** asked when its turn in the queue comes: true drops it unseen (a line whose thread is on screen by then: events.ts) */
  skip?: () => boolean;
}

export interface IslandState {
  /** the vocabulary token, e.g. "tool:k_weather" */
  state: AgentState;
  kind: AgentKind;
  /** tool name while kind === "tool" */
  tool: string | null;
  /** Korean status text, without the elapsed time ("" while idle and during the first second of thinking) */
  text: string;
  /** whole seconds in the current state once ≥ 2 s, else 0 */
  elapsed: number;
  /** busy and no event for 15 s */
  stalled: boolean;
  /** 0..1 from a real source only (mic level while listening, token rate while streaming) */
  level: number;
  /** the thread the running turn belongs to */
  threadId: string | null;
  /** the turn runs elsewhere (another tab / a schedule): no stall clock, no stop */
  remote: boolean;
  /** polite live-region text (AgentLive) — changes only when worth announcing */
  announce: string;
  offline: boolean;
  call: IslandCall | null;
  banner: IslandBanner | null;
}

const INITIAL: IslandState = {
  state: "idle",
  kind: "idle",
  tool: null,
  text: "",
  elapsed: 0,
  stalled: false,
  level: 0,
  threadId: null,
  remote: false,
  announce: "",
  offline: false,
  call: null,
  banner: null,
};

export const islandStore = createStore<IslandState>({ ...INITIAL });
export const useIsland = <S = IslandState>(sel?: (s: IslandState) => S) =>
  useStore(islandStore, sel ?? ((s: IslandState) => s as unknown as S));
/** the shared agent-state vocabulary (composer, tool chips, live region) — same store as the island */
export const useAgentState = useIsland;

export interface IslandHandlers {
  /** abort the running turn (stalled → "멈추기") */
  stop?: () => void;
  /** retry the failed send (error → "다시 시도할까요?") */
  retry?: () => void;
  /** open the thread the agent is working in (busy / awaiting approval) */
  open?: (threadId: string | null) => void;
}
let handlers: IslandHandlers = {};
let tapHandler: (() => void) | null = null;

const STALL_MS = 15000;
const DONE_MS = 1600;
const ERROR_MS = 10000;
const THINK_TEXT_MS = 1000;

let since = 0; // performance.now() when the current state was entered
let lastEvent = 0;
let tick: ReturnType<typeof setTimeout> | undefined;
let doneTimer: ReturnType<typeof setTimeout> | undefined;
let bannerTimer: ReturnType<typeof setTimeout> | undefined;
let bannerDeadline = 0;
let bannerRemaining = 0;
let bannerCap: ReturnType<typeof setTimeout> | undefined;
/**
 * A top banner never stays longer than this in all, however long a mouse, pen or focus rests on it (the lead's rule,
 * 2026-11-12); the undo toast keeps its own pause (it sits at the bottom and covers nothing).
 */
export const BANNER_CAP_MS = 8000;
let bannerSeq = 0;
const queue: IslandBanner[] = [];

const now = () => performance.now();

function announceFor(kind: AgentKind, text: string, extra?: string) {
  switch (kind) {
    case "listening":
      return "듣는 중";
    case "tool":
      return text;
    case "awaiting_approval":
      return extra ? `승인이 필요해요: ${extra}` : "승인이 필요해요";
    case "done":
      return "완료했어요";
    case "error":
      return "보내지 못했어요. 다시 시도할 수 있어요";
    case "offline":
      return "오프라인이에요";
    default:
      return ""; // thinking announces after 1 s (ticker); streaming is read by the thread; call time is not read
  }
}

/** enter a state; same state = only refresh text (no elapsed reset) */
function enter(state: AgentState, text: string, opts: { threadId?: string | null; announceExtra?: string; remote?: boolean } = {}) {
  const s = islandStore.get();
  if (s.kind === "call" && state !== "call") {
    // the call owns the island; remember nothing else
    return;
  }
  clearTimeout(doneTimer);
  const kind: AgentKind = state.startsWith("tool:") ? "tool" : (state as AgentKind);
  const t = now();
  lastEvent = t;
  if (s.state === state) {
    const remote = opts.remote ?? s.remote;
    if (s.text !== text || s.stalled || s.remote !== remote) islandStore.patch({ text: s.kind === "thinking" ? s.text : text, stalled: false, remote });
    schedule();
    return;
  }
  since = t;
  const tool = kind === "tool" ? state.slice(5) : null;
  const shownText = kind === "thinking" ? "" : text;
  islandStore.patch({
    state,
    kind,
    tool,
    text: shownText,
    elapsed: 0,
    stalled: false,
    level: kind === "streaming" || kind === "listening" ? s.level : 0,
    threadId: opts.threadId !== undefined ? opts.threadId : kind === "idle" || kind === "offline" ? null : s.threadId,
    remote: isBusy(kind) ? (opts.remote ?? (s.remote && isBusy(s.kind))) : false,
    announce: announceFor(kind, text, opts.announceExtra) || s.announce,
  });
  if (kind !== "streaming") stopMeter();
  schedule();
}

/** one timer aligned to whole seconds of the current state (only while not idle): label at 1 s, elapsed ≥ 2 s, stall at 15 s */
function schedule() {
  clearTimeout(tick);
  tick = undefined;
  const s = islandStore.get();
  if (s.kind === "idle" || s.kind === "offline" || s.kind === "call" || s.kind === "done" || s.kind === "error") return;
  const t = now();
  const inState = t - since;
  const nextSecond = 1000 - (inState % 1000) + 5;
  tick = setTimeout(onTick, nextSecond);
}

function onTick() {
  const s = islandStore.get();
  const t = now();
  const secs = Math.floor((t - since) / 1000);
  const patch: Partial<IslandState> = {};
  const elapsed = secs >= 2 ? secs : 0;
  if (elapsed !== s.elapsed) patch.elapsed = elapsed;
  if (s.kind === "thinking" && t - since >= THINK_TEXT_MS && s.text !== "생각하는 중") {
    patch.text = "생각하는 중";
    patch.announce = "생각하는 중";
  }
  if (isBusy(s.kind) && !s.remote && !s.stalled && t - lastEvent >= STALL_MS) {
    patch.stalled = true;
    patch.announce = "오래 걸리고 있어요. 멈출 수 있어요";
  }
  if (Object.keys(patch).length) islandStore.patch(patch);
  schedule();
}

// token-rate meter: exponentially-decayed tokens/s mapped to 0..1; runs only while streaming
let rate = 0;
let lastTok = 0;
let meter: ReturnType<typeof setInterval> | undefined;
function setLevel(level: number) {
  const s = islandStore.get();
  if (Math.abs(s.level - level) < 0.02 && !(level === 0 && s.level !== 0)) return;
  islandStore.patch({ level });
}
function startMeter() {
  if (meter) return;
  meter = setInterval(() => {
    if (now() - lastTok > 250) rate *= 0.6;
    if (rate < 0.5) rate = 0;
    setLevel(Math.min(1, rate / 40));
  }, 100);
}
function stopMeter() {
  if (meter) clearInterval(meter);
  meter = undefined;
  rate = 0;
  if (islandStore.get().level !== 0 && islandStore.get().kind !== "listening") islandStore.patch({ level: 0 });
}

function charCount(b: Pick<IslandBanner, "title" | "body">) {
  return b.title.length + (b.body?.length ?? 0);
}
/** MOTION-SPEC §8.13: 1.5 s + 60 ms × characters, clamped to 2–4 s */
export function bannerHold(b: Pick<IslandBanner, "title" | "body">) {
  return Math.min(4000, Math.max(2000, 1500 + 60 * charCount(b)));
}

function armBanner(id: number, ms: number) {
  clearTimeout(bannerTimer);
  bannerRemaining = ms;
  bannerDeadline = now() + ms;
  bannerTimer = setTimeout(() => island.dismissBanner(id), ms);
}

function showNextBanner() {
  if (islandStore.get().banner) return;
  let next = queue.shift();
  // banners wait their turn one at a time: one whose moment passed meanwhile goes unseen, and the next is asked
  while (next?.skip?.()) next = queue.shift();
  if (!next) return;
  islandStore.patch({ banner: next });
  armBanner(next.id, next.hold ?? bannerHold(next));
  clearTimeout(bannerCap);
  if (next.kind !== "undo") bannerCap = setTimeout(() => island.dismissBanner(next.id), BANNER_CAP_MS);
}

function setOffline(off: boolean) {
  const s = islandStore.get();
  if (s.offline === off) return;
  islandStore.patch({ offline: off });
  if (off && (s.kind === "idle" || s.kind === "done")) enter("offline", "오프라인");
  else if (!off && s.kind === "offline") enter("idle", "");
}
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => setOffline(false));
  if (typeof navigator !== "undefined" && navigator.onLine === false) queueMicrotask(() => setOffline(true));
}

export const island = {
  setHandlers(h: IslandHandlers) {
    handlers = { ...handlers, ...h };
  },
  get handlers(): Readonly<IslandHandlers> {
    return handlers;
  },

  listening() {
    enter("listening", "듣는 중");
  },
  /** real microphone input level 0..1 (only meaningful while listening) */
  micLevel(v: number) {
    if (islandStore.get().kind !== "listening") return;
    setLevel(Math.max(0, Math.min(1, v)));
  },
  /** `remote`: the turn runs in another tab / a schedule — shown, but no stall clock and nothing to stop */
  thinking(threadId?: string | null, opts: { remote?: boolean } = {}) {
    enter("thinking", "생각하는 중", { threadId, remote: opts.remote ?? false });
  },
  /** a tool started / changed state — the label comes from the real tool name (unknown → "작업하는 중") */
  tool(name: string, title?: string) {
    if (!name && title) enter("tool:", title);
    else enter(`tool:${name}`, toolLabel(name, title));
  },
  /** @deprecated thin wrapper (FOUNDATION v1): a busy state with a custom label — prefer tool(name) */
  working(label = "작업하는 중") {
    enter("tool:", label);
  },
  /** the answer is streaming (tokens() also enters it) */
  streaming() {
    if (islandStore.get().kind !== "streaming") enter("streaming", "답하는 중");
    else island.event();
  },
  /** a real level 0..1: mic input (listening / call) or a token rate (streaming); ignored in other states */
  level(v: number) {
    const k = islandStore.get().kind;
    if (k !== "listening" && k !== "streaming" && k !== "call") return;
    setLevel(Math.max(0, Math.min(1, v)));
  },
  /** navigator.onLine is watched already; call to force (tests) */
  offline(on: boolean) {
    setOffline(on);
  },
  /** the call owns the island (agentState.set("call")); island.call() fills in the caller + timer */
  callState(threadId?: string | null) {
    const s = islandStore.get();
    if (s.kind === "call") {
      if (threadId !== undefined) islandStore.patch({ threadId });
      return;
    }
    clearTimeout(doneTimer);
    stopMeter();
    since = now();
    islandStore.patch({ state: "call", kind: "call", tool: null, text: "통화 연결 중", elapsed: 0, stalled: false, level: 0, threadId: threadId ?? s.threadId });
    schedule();
  },
  /** what a tap does when the island is not handling it itself (call / stall / error); null = default (open thread) */
  setTapHandler(fn: (() => void) | null) {
    tapHandler = fn;
  },
  /** streamed text arrived: feed the number of tokens (≈ characters / 2) */
  tokens(n: number) {
    const s = islandStore.get();
    if (s.kind !== "streaming") enter("streaming", "답하는 중");
    else lastEvent = now();
    if (islandStore.get().stalled) islandStore.patch({ stalled: false });
    const t = now();
    const dt = Math.max(0.016, (t - (lastTok || t - 100)) / 1000);
    lastTok = t;
    rate = rate * 0.7 + (n / dt) * 0.3;
    startMeter();
  },
  /** any server event for the running turn (status / tool / card …): resets the stall clock */
  event() {
    lastEvent = now();
    if (islandStore.get().stalled) islandStore.patch({ stalled: false });
  },
  awaitingApproval(title?: string) {
    enter("awaiting_approval", "승인이 필요해요", { announceExtra: title });
  },
  done(text = "완료했어요") {
    const s = islandStore.get();
    if (s.kind === "call") return;
    enter("done", text);
    doneTimer = setTimeout(() => island.idle(), DONE_MS);
  },
  error(text = "다시 시도할까요?") {
    if (islandStore.get().kind === "call") return;
    enter("error", text);
    doneTimer = setTimeout(() => {
      if (islandStore.get().kind === "error") island.idle();
    }, ERROR_MS);
  },
  idle() {
    const s = islandStore.get();
    if (s.kind === "call") return;
    stopMeter();
    if (s.offline) enter("offline", "오프라인");
    else enter("idle", "");
  },
  /** dev / QA: pretend the current state began `ms` earlier and nothing has arrived since (elapsed + stall demos) */
  debugAge(ms: number) {
    since -= ms;
    lastEvent -= ms;
    onTick();
  },
  /** tap on the island: what the current state offers */
  press() {
    const s = islandStore.get();
    if (s.kind === "call") return island.toggleCallExpanded();
    if (s.stalled && !s.remote) return handlers.stop?.();
    if (s.kind === "error") return handlers.retry?.();
    if (tapHandler) return tapHandler();
    if (isBusy(s.kind) || s.kind === "awaiting_approval") return handlers.open?.(s.threadId);
  },

  call(c: { name: string; startedAt?: number }) {
    clearTimeout(doneTimer);
    stopMeter();
    since = now();
    islandStore.patch({
      state: "call",
      kind: "call",
      tool: null,
      text: "",
      elapsed: 0,
      stalled: false,
      level: 0,
      announce: `${c.name} 통화 연결됨`,
      call: { name: c.name, startedAt: c.startedAt ?? Date.now(), muted: false, speaker: false, expanded: true, amplitude: 0 },
    });
    schedule();
  },
  updateCall(patch: Partial<IslandCall>) {
    const s = islandStore.get();
    if (!s.call) return;
    islandStore.patch({ call: { ...s.call, ...patch } });
  },
  toggleCallExpanded() {
    const s = islandStore.get();
    if (s.call) islandStore.patch({ call: { ...s.call, expanded: !s.call.expanded, held: false } });
  },
  /** long-press on the call pill: the island grows in place into mute and end (a tap opens the call card instead) */
  holdCall() {
    const s = islandStore.get();
    if (s.call && !s.call.expanded) islandStore.patch({ call: { ...s.call, expanded: true, held: true } });
  },
  endCall() {
    islandStore.patch({ state: "idle", kind: "idle", call: null, text: "", level: 0, announce: "통화가 끝났어요" });
    if (islandStore.get().offline) enter("offline", "오프라인");
  },

  /** queue a banner (one at a time). Returns its id. */
  banner(b: Omit<IslandBanner, "id">): number {
    const id = ++bannerSeq;
    const tone = b.tone ?? (b.kind === "error" ? "error" : "default");
    queue.push({ ...b, tone, id });
    showNextBanner();
    return id;
  },
  /** an error banner: role=alert, contracts into a red dot back into the island */
  errorBanner(message: string, title = "문제가 생겼어요"): number {
    return island.banner({ icon: "bolt", tone: "error", title, body: message });
  },
  /** low-risk action already done → 5 s 실행 취소, shown as the bottom UndoToast, not over the top bar (MOTION-SPEC §8.13) */
  undo(b: { title: string; body?: string; icon?: IconName; label?: string; onUndo: () => unknown; onExpire?: () => void; ms?: number }): number {
    return island.banner({
      kind: "undo",
      icon: b.icon ?? "checkmark",
      title: b.title,
      body: b.body,
      hold: b.ms ?? 5000,
      action: { label: b.label ?? "실행 취소", run: b.onUndo },
      onExpire: b.onExpire,
    });
  },
  /** pause the hold while a finger / pointer / focus is on the banner; resumes with the time that was left */
  holdBanner(on: boolean) {
    const s = islandStore.get();
    if (!s.banner) return;
    if (on) {
      if (bannerTimer === undefined) return;
      clearTimeout(bannerTimer);
      bannerTimer = undefined;
      bannerRemaining = Math.max(0, bannerDeadline - now());
    } else if (bannerTimer === undefined) {
      armBanner(s.banner.id, Math.max(1200, bannerRemaining));
    }
  },
  /** reason "action": its action button was pressed (onExpire is not called); otherwise it timed out / was swiped */
  dismissBanner(id?: number, reason: "expire" | "action" = "expire") {
    const s = islandStore.get();
    if (!s.banner || (id !== undefined && s.banner.id !== id)) return;
    clearTimeout(bannerTimer);
    clearTimeout(bannerCap);
    bannerTimer = undefined;
    const b = s.banner;
    islandStore.patch({ banner: null });
    if (reason !== "action") b.onExpire?.();
    // let the contraction play before the next one drops
    if (queue.length) setTimeout(showNextBanner, 520);
  },
  /** drop the shown banner and everything queued (sign-out, onboarding reset, tests); no onExpire */
  clearBanners() {
    queue.length = 0;
    clearTimeout(bannerTimer);
    clearTimeout(bannerCap);
    bannerTimer = undefined;
    if (islandStore.get().banner) islandStore.patch({ banner: null });
  },
};
