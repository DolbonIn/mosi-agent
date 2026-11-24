/**
 * Turn wrapper around @pickle/agent's runTurn: `start` → history/recall/system/tools → runTurn
 * (streams status/text/tool/card) → persist assistant message + approvals + usage → `done`.
 * Also: background (system-initiated) turns and steer follow-ups.
 */
import type { AgentEvent, Card, IconName, Message, ThreadKind, ToolActivity, UserSettings } from "@pickle/protocol";
import type { ApprovalSpec, LlmMessage, LlmToolCall, ToolContext, ToolDef, TurnInput, TurnOutcome } from "@pickle/agent";
import type { LeaseLike } from "./deps.ts";
import type { MessageRow, ThreadRow, UserRow } from "./db/index.ts";
import { agentFor, messageView, publishMessage, publishThread, QUOTA_MESSAGE, quotaExceeded, quotaFor, settingsOf, type Core } from "./core.ts";
import { CANCEL_NOTE_MESSAGE, CANCEL_RULE, friendHistoryFromRows, hasCancelNote, historyForResume, historyFromRows, isSystemRequest } from "./history.ts";
import { quotaDay } from "./kst.ts";
import { makeToolStore } from "./toolstore.ts";
import { phoneTools } from "./phone.ts";
import { meetPromptNote, meetTools } from "./meet.ts";
import { newId, preview, safeJson } from "./util.ts";
import { errInfo } from "./log.ts";
import { SseChannel } from "./events.ts";
import { kskillConnectedNames, skillsWithoutLogins, trackConnectionCards } from "./kskill.ts";
import type { Ctx } from "./http.ts";

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

/** Makes release() idempotent so error paths can always release safely. */
export function guardLease(l: LeaseLike): LeaseLike {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      l.release();
    },
    steer: (t: string) => l.steer(t),
    drain: () => (released ? [] : l.drain()),
    pending: () => (released ? 0 : (l.pending?.() ?? 0)),
  };
}

export interface HeldLease extends LeaseLike {
  /** record the thread this lease works in, once it is known (scheduler creates threads lazily) */
  bindThread(threadId: string): void;
  /** the client stopped this turn: new messages wait for it to wind down instead of being steered into it */
  markStopping(): void;
  /** the rows of the lines steered into this turn so far (`noteSteered`), oldest first */
  steeredIds(): string[];
}

/**
 * Wraps a freshly acquired lease. release() becomes idempotent, always drains first (so the
 * launcher never carries undrained steers over into an unrelated turn), and the server remembers
 * which thread holds the user's agent, so text sent to *another* thread is never steered into it.
 * Call it synchronously right after acquiring.
 */
export function holdLease(core: Core, userId: string, threadId: string | null, raw: LeaseLike): HeldLease {
  const token = {};
  let released!: () => void;
  const done = new Promise<void>((res) => (released = res));
  const entry: { threadId: string | null; token: object; stopping?: Promise<void>; steered: string[] } = { threadId, token, steered: [] };
  core.activeTurns.set(userId, entry);
  const g = guardLease(raw);
  return {
    release() {
      if (core.activeTurns.get(userId)?.token === token) core.activeTurns.delete(userId);
      try {
        g.drain();
      } catch {
        /* ignore */
      }
      try {
        g.release();
      } finally {
        released();
      }
    },
    markStopping() {
      entry.stopping ??= done;
    },
    steeredIds: () => [...entry.steered],
    steer: (t: string) => g.steer(t),
    drain: () => g.drain(),
    pending: () => g.pending?.() ?? 0,
    bindThread(id: string) {
      const cur = core.activeTurns.get(userId);
      if (cur?.token === token) cur.threadId = id;
    },
  };
}

/**
 * If the user's running turn was stopped by its client and is still winding down (aborting the
 * model call, the settle wait, the cancel note), wait for it — up to `maxMs` — so a message sent
 * right after Stop starts a fresh turn instead of being steered into the stopped one (where it
 * would be cancelled with it). Returns true if a stopped turn still holds the agent afterwards.
 */
export async function waitForStoppedTurn(core: Core, userId: string, maxMs: number): Promise<boolean> {
  const stopping = core.activeTurns.get(userId)?.stopping;
  if (!stopping) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([stopping, new Promise<void>((res) => (timer = setTimeout(res, maxMs)))]);
  clearTimeout(timer);
  return !!core.activeTurns.get(userId)?.stopping;
}

/** The error `p` rejects with, if it settles that way within `ms`; null if it resolves or is still running. */
async function settledRejection(p: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([
    p.then(
      () => null,
      (err: unknown) => err ?? null,
    ),
    new Promise<null>((res) => (timer = setTimeout(() => res(null), ms))),
  ]);
  clearTimeout(timer);
  return r;
}

/** The line stored as `messageId` was just steered into the user's running turn (the send's 202): remember it there. */
export function noteSteered(core: Core, userId: string, messageId: string): void {
  core.activeTurns.get(userId)?.steered.push(messageId);
}

/** Thread whose turn currently holds the user's agent (undefined = idle, null = not steerable). */
export function activeThreadOf(core: Core, userId: string): string | null | undefined {
  const cur = core.activeTurns.get(userId);
  return cur ? cur.threadId : undefined;
}

/**
 * Tokens charged to the daily quota: prompt tokens served from the provider's prefix cache cost
 * about a tenth of fresh ones, so they count at 10% (mirrors @pickle/agent `billableTokens`).
 */
export function billable(u: { promptTokens?: number; totalTokens?: number; cachedTokens?: number } | null | undefined): number {
  if (!u) return 0;
  const total = Number(u.totalTokens) || 0;
  const cached = Math.min(Number(u.cachedTokens) || 0, Number(u.promptTokens) || 0);
  return Math.max(0, Math.round(total - cached * 0.9));
}

/** Rough token count for text we sent/received but got no usage report for (aborted turns). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2);
}

export interface ResumeSpec {
  call: LlmToolCall;
  decision: "approve" | "reject";
  priorMessages: LlmMessage[];
  pausedMessageId: string;
}

export interface ExecuteTurnOptions {
  userId: string;
  threadId: string;
  /** text handed to runTurn (null on approval resume) */
  userText: string | null;
  /** persisted message shown in the `start` event */
  userMessage: Message | null;
  /** a queued send: its stream already sent `start` with this assistant row id, so the turn reuses it and sends no second `start` */
  announcedMessageId?: string;
  mode: "text" | "voice";
  lease: LeaseLike;
  sink: (e: AgentEvent) => void;
  /** aborted when the client disconnects */
  signal?: AbortSignal;
  initiatedBy: "user" | "system";
  resume?: ResumeSpec;
  /** replay history strictly before this message (the turn's own user/event row) */
  historyBeforeId?: string;
  /** steer follow-ups: skip trailing user rows with these texts (they are the new userText) */
  historyExcludeTexts?: Set<string>;
  /**
   * Who the agent is answering: the owner (default), or someone else ("other": a conversation with a third party; a
   * shared thread counts as one). Such a turn never runs on the owner's k-skill logins: no login or write tools, no
   * resolver, no connect wait, no connected-service names in the prompt.
   */
  speaker?: "owner" | "other";
  /**
   * A turn that leaves no text and no card stores no assistant row (a briefing attempt: its tool chips would stand alone
   * in the thread and its tool calls in history, and the scheduler tries again). Its usage still counts.
   */
  dropBareRow?: boolean;
  /**
   * The turn answers lines the person sent (a steer follow-up; these are their rows, oldest first): a failure is shown to
   * them (`turn_error`), and the rows go out in its `steers_dropped`
   */
  forSteered?: string[];
}

export interface TurnResult {
  message: Message | null;
  error: { error: string; message: string } | null;
  aborted: boolean;
}

const KIND_SUBTITLE_FIXED: ThreadKind[] = ["task", "call", "schedule"];

export function classifyError(err: unknown, timedOut: boolean): { error: string; message: string } {
  if (timedOut) return { error: "upstream_timeout", message: "응답이 너무 늦어지고 있어요. 잠시 후 다시 시도해 주세요." };
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" || (err instanceof Error && err.name === "UpstreamError")) {
    if (status === 429) return { error: "upstream_rate_limited", message: "지금 요청이 많아요. 잠시 후 다시 시도해 주세요." };
    if (status === 401 || status === 403) return { error: "upstream_auth", message: "AI 서버 인증에 문제가 있어요. 관리자에게 알려 주세요." };
    return { error: "upstream_error", message: "AI 서버와 연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요." };
  }
  return { error: "internal", message: "처리 중에 문제가 생겼어요. 다시 시도해 주세요." };
}

/**
 * Memory tools per turn: "off" = the user turned memory off (no remember/recall at all);
 * "empty" = nothing saved yet, so a recall round-trip can only come back empty (it used to cost a
 * new user's first turn a whole extra model call); "on" = both.
 */
export type MemoryTools = "off" | "empty" | "on";

/** Tool list for a thread: system + skills + messengers + server tools, de-duplicated by name. */
export function buildTools(core: Core, kind: ThreadKind, enabledSkills: string[] | undefined, memory: MemoryTools = "on", userId?: string, others = kind === "friend"): ToolDef[] {
  const out: ToolDef[] = [];
  const seen = new Set<string>();
  // shared threads never recall the owner's memories (the friend reads the answer)
  if (memory === "off") seen.add("sys_remember").add("sys_recall");
  else if (memory === "empty" || kind === "friend") seen.add("sys_recall");
  const add = (label: string, fn: () => ToolDef[]) => {
    let defs: ToolDef[] = [];
    try {
      defs = fn();
    } catch (err) {
      core.log.warn("tools unavailable", { source: label, err: errInfo(err) });
    }
    for (const d of defs) {
      if (!d || typeof d.name !== "string" || seen.has(d.name)) continue;
      // someone other than the owner (a shared thread, a third party) never gets the owner's k-skill logins (팝빌,
      // 토스증권 …) or an acting tool on them
      if (others && (d.connection || d.write)) continue;
      seen.add(d.name);
      out.push(d);
    }
  };
  add("system", () => core.deps.systemTools());
  add("skills", () => core.deps.skills.skillTools(enabledSkills && enabledSkills.length ? enabledSkills : undefined));
  if (kind !== "friend") {
    // shared threads never get access to the owner's messengers or the phone
    add("messengers", () => core.deps.hub.tools());
    add("server", () => [...phoneTools(core), ...meetTools(core, userId)]);
  }
  return out;
}

/**
 * Results that are no source of a time: the clock itself, the schedule tool's own echo, and the card tool (its design
 * guide says "(정오 included)": a quote '오후 12:00 임시' was taken as heard there and a made-up noon got saved; and the
 * card is the model's own words).
 */
const NOT_HEARD = new Set(["sys_time", "sys_schedule_create", "sys_create_artifact"]);
const HEARD_CAP = 256 * 1024;

/**
 * The tool with its results noted in `into` (summary and every string in data, ≤ 256 KB a turn, newest kept): a time
 * read from a calendar, a mail or a page counts as heard (ToolContext.heard). Nothing is logged.
 */
function heardFrom(def: ToolDef, into: string[]): ToolDef {
  if (NOT_HEARD.has(def.name)) return def;
  return {
    ...def,
    async run(args, ctx) {
      const r = await def.run(args, ctx);
      try {
        const texts: string[] = [];
        const walk = (v: unknown, depth: number) => {
          if (typeof v === "string") texts.push(v);
          else if (depth < 6 && v && typeof v === "object") for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
        };
        walk(r?.summary, 0);
        walk(r?.data, 0);
        into.push(texts.join("\n").slice(0, HEARD_CAP));
        let total = into.reduce((n, t) => n + t.length, 0);
        while (total > HEARD_CAP && into.length > 1) total -= into.shift()!.length;
      } catch {
        // a result we can't read is no source
      }
      return r;
    },
  };
}

function namesFor(core: Core, userId: string | null): { display: string; agent: string } {
  const u = userId ? core.db.userById(userId) : null;
  return { display: u?.display_name ?? "친구", agent: u?.agent_name ?? "모시" };
}

async function connectedNames(core: Core, userId: string): Promise<string[]> {
  let messengers: string[] = [];
  try {
    const conns = await core.deps.hub.connections(userId);
    const names = new Map(core.deps.providers().map((p) => [p.id, p.name]));
    messengers = conns.filter((c) => c.status === "connected").map((c) => names.get(c.provider) ?? c.provider);
  } catch {
    messengers = [];
  }
  // k-skill logins by name only ("팝빌", "토스증권")
  return [...messengers, ...(await kskillConnectedNames(core, userId))];
}

function friendThreadNote(core: Core, thread: ThreadRow, userId: string): string {
  const peerId = core.db.threadMembers(thread.id).find((id) => id !== userId) ?? null;
  const peer = namesFor(core, peerId);
  return [
    "",
    "## 공유 대화방 규칙",
    `이 대화는 주인과 친구 ${peer.display} 님이 함께 보는 공유 대화방이에요. 친구와 친구의 모시(${peer.agent})도 이 답장을 읽어요.`,
    "주인의 기억·일정·연결된 계정·저장된 정보 같은 개인정보는 주인이 이 대화에서 분명히 부탁하지 않는 한 절대 꺼내지 마세요.",
    "답은 짧고 친근하게 하세요.",
  ].join("\n");
}

function ensureApprovalCard(cards: Card[], approvalId: string, spec: ApprovalSpec): Card[] {
  if (cards.some((c) => c.type === "approval" && c.approvalId === approvalId)) return cards;
  let replaced = false;
  const out = cards.map((c) => {
    if (!replaced && c.type === "approval" && c.status === "pending") {
      replaced = true;
      return { ...c, approvalId };
    }
    return c;
  });
  if (!replaced) {
    out.push({
      type: "approval",
      approvalId,
      title: spec.title,
      detail: spec.detail,
      ...(spec.amount !== undefined ? { amount: spec.amount } : {}),
      ...(spec.call ? { call: spec.call } : {}),
      ...(spec.meet ? { meet: spec.meet } : {}),
      status: "pending",
    });
  }
  return out;
}

function ensureCredentialCard(cards: Card[], need: NonNullable<TurnOutcome["pendingCredential"]>): Card[] {
  if (cards.some((c) => c.type === "credential_request" && c.service === need.service && c.status === "pending")) return cards;
  return [
    ...cards,
    { type: "credential_request", service: need.service, serviceName: need.serviceName, reason: need.reason, fields: need.fields, status: "pending" },
  ];
}

/**
 * Runs one agent turn and persists its result. Owns the lease: releases it at the end and turns
 * any steered text that arrived too late into a background follow-up turn.
 */
export async function executeTurn(core: Core, o: ExecuteTurnOptions): Promise<TurnResult> {
  const { db, deps, log } = core;
  const startedAt = core.now();
  const messageId = o.announcedMessageId ?? newId("m");

  let user: UserRow;
  let thread: ThreadRow;
  let settings: UserSettings;
  try {
    if (!o.announcedMessageId) o.sink({ type: "start", threadId: o.threadId, userMessage: o.userMessage, messageId });
    const u = db.userById(o.userId);
    const t = db.threadFor(o.threadId, o.userId);
    if (!u || !t) throw new Error("user or thread vanished");
    user = u;
    thread = t;
    settings = settingsOf(u);
    try {
      deps.launcher.setStatus(o.userId, "running");
    } catch {
      /* ignore */
    }
    core.events.publish(o.userId, { type: "agent_status", status: "running", text: "일하는 중" });
  } catch (err) {
    // nothing ran yet: report, free the agent, and stop (no follow-up turn for leftovers)
    log.error("turn setup failed", { user: o.userId, thread: o.threadId, err: errInfo(err) });
    const error = { error: "internal", message: "처리 중에 문제가 생겼어요. 다시 시도해 주세요." };
    try {
      o.sink({ type: "error", ...error });
    } catch {
      /* ignore */
    }
    try {
      o.lease.release();
    } catch {
      /* ignore */
    }
    return { message: null, error, aborted: false };
  }
  const isFriend = thread.kind === "friend";
  /** the owner's k-skill logins stay out of this turn (see ExecuteTurnOptions.speaker) */
  const othersPresent = isFriend || o.speaker === "other";

  // live state, so we can persist partial output if the turn is aborted or fails
  let text = "";
  const tools = new Map<string, ToolActivity>();
  const cards: Card[] = [];
  let finished = false;
  let timedOut = false;

  const ac = new AbortController();
  const onClientGone = () => {
    // from now on new messages wait for this turn to wind down instead of steering into it
    try {
      (o.lease as Partial<HeldLease>).markStopping?.();
    } catch {
      /* ignore */
    }
    ac.abort(new DOMException("client disconnected", "AbortError"));
  };
  if (o.signal) {
    if (o.signal.aborted) onClientGone();
    else o.signal.addEventListener("abort", onClientGone, { once: true });
  }
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      ac.abort(new DOMException("upstream timeout", "TimeoutError"));
    }, core.cfg.turnIdleTimeoutMs);
  };
  const maxTimer = setTimeout(() => {
    timedOut = true;
    ac.abort(new DOMException("turn too long", "TimeoutError"));
  }, core.cfg.turnMaxMs);

  // runTurn's approval cards carry a provisional id (= the tool call id); swap in our DB id as
  // they stream, so the client can POST /api/approvals/:id straight from the `card` event
  const approvalIds = new Map<string, string>();
  const approvalIdFor = (provisional: string) => {
    let id = approvalIds.get(provisional);
    if (!id) {
      id = newId("ap");
      approvalIds.set(provisional, id);
    }
    return id;
  };
  const swapCard = (c: Card): Card => (c.type === "approval" && c.status === "pending" ? { ...c, approvalId: approvalIdFor(c.approvalId) } : c);

  // wall-clock phase marks for the "turn done" log line (latency work; numbers only)
  const t0 = performance.now();
  const phases: string[] = [];
  const mark = (name: string) => {
    if (phases.length < 24) phases.push(`${name}:${Math.round(performance.now() - t0)}`);
  };
  let sawEvent = false;
  let sawText = false;
  const loginCards = trackConnectionCards(core, o.userId);

  const emit = (e: AgentEvent) => {
    if (finished) return;
    armIdle();
    if (!sawEvent) {
      sawEvent = true;
      mark("first_event");
    }
    if (e.type === "text") {
      if (!sawText && e.delta.trim()) {
        sawText = true;
        mark("first_text");
      }
      text += e.delta;
    } else if (e.type === "tool") {
      const prev = tools.get(e.tool.id);
      if (!prev || prev.state !== e.tool.state) mark(`${e.tool.name}.${e.tool.state}`);
      tools.set(e.tool.id, e.tool);
    }
    else if (e.type === "card") {
      e = { ...e, card: swapCard(e.card) };
      cards.push(e.card);
      loginCards.onCard(e.card);
    } else if (e.type === "start" || e.type === "done") return; // owned by the server
    o.sink(e);
  };

  let outcome: TurnOutcome | null = null;
  let failure: unknown = null;
  /** the person's lines steered into this turn */
  const steered: string[] = [];
  let runPromise: Promise<TurnOutcome> | null = null;
  let promptChars = 0;
  try {
    const profile = await agentFor(core, user);
    const enabled = profile.enabledSkills;
    mark("profile");

    // history
    let history: LlmMessage[];
    if (isFriend) {
      const rows = db.historyRows(o.threadId, 60, o.historyBeforeId);
      history = friendHistoryFromRows(rows, o.userId, (id) => namesFor(core, id));
    } else if (o.resume) {
      history = historyForResume(db.historyRows(o.threadId, 60, o.resume.pausedMessageId), o.resume.priorMessages);
    } else {
      history = historyFromRows(db.historyRows(o.threadId, 60, o.historyBeforeId), { excludeTrailingUserTexts: o.historyExcludeTexts });
    }

    mark("history");
    let recalled: string[] = [];
    if (settings.privacy.memoryEnabled && !isFriend && o.userText) {
      try {
        recalled = await deps.launcher.recall(o.userId, o.userText, 5);
      } catch (err) {
        log.warn("recall failed", { user: o.userId, err: errInfo(err) });
      }
    }
    mark("recall");
    let skillLines: string[] = [];
    try {
      // shared threads: no lines for the owner's login tools (buildTools leaves those tools out there)
      skillLines = deps.skills
        .skillCatalogForPrompt(othersPresent ? skillsWithoutLogins(core, enabled) : enabled.length ? enabled : undefined)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      skillLines = [];
    }
    const connections = othersPresent ? [] : await connectedNames(core, o.userId);
    mark("connections");
    let system = await deps.launcher.systemPrompt(o.userId, {
      displayName: user.display_name,
      now: new Date(core.now()),
      mode: o.mode,
      connections,
      skills: skillLines,
      recalled,
    });
    if (isFriend) system += friendThreadNote(core, thread, o.userId);
    else {
      // the user's meetings right now + "meeting content comes from sys_meet_notes" (only once they have one)
      const meet = meetPromptNote(core, o.userId, o.threadId);
      if (meet) system += `\n\n${meet}`;
    }
    // a stopped request in history: tell the model not to pick it up again (see CANCEL_RULE)
    if (hasCancelNote(history)) system += `\n\n${CANCEL_RULE}`;
    mark("prompt");

    // where a time may come from (sys_schedule_create's time_quote): what the user said and what tools returned
    const toolHeard: string[] = [];
    const recentUser = history.flatMap((m) => (m.role === "user" ? [m.content] : [])).slice(-6);
    // history's tool results by the tool that gave them: NOT_HEARD ones are no source there either
    const callName = new Map(history.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => [c.id, c.function.name] as const) : [])));
    const recentTools = history
      .flatMap((m) => (m.role === "tool" && !NOT_HEARD.has(callName.get(m.tool_call_id) ?? "") ? [m.content] : []))
      .slice(-12);
    const ctx: ToolContext = {
      userId: o.userId,
      threadId: o.threadId,
      agentName: user.agent_name,
      displayName: user.display_name,
      workspaceDir: deps.launcher.workspaceDir(o.userId),
      signal: ac.signal,
      credentials: deps.vault.access(o.userId, { actor: "agent" }),
      store: makeToolStore(core, o.userId, o.threadId),
      mode: o.mode,
      status: (s: string) => emit({ type: "status", text: s }),
      now: () => new Date(core.now()),
      // k-skill logins: only when the owner is the one being answered (see buildTools)
      ...(othersPresent ? {} : { connections: core.connections.forUser(o.userId) }),
      heard: () => [...recentUser, ...(o.userText ? [o.userText] : []), ...steered, ...recentTools, ...toolHeard],
    };

    let memory: MemoryTools = "on";
    if (!settings.privacy.memoryEnabled) memory = "off";
    else {
      try {
        memory = (await deps.launcher.listMemories(o.userId)).length ? "on" : "empty";
      } catch {
        memory = "on";
      }
    }
    const toolDefs = buildTools(core, thread.kind, enabled, memory, o.userId, othersPresent).map((d) => heardFrom(d, toolHeard));
    mark("tools");
    const input: TurnInput = {
      ctx,
      system,
      history,
      userText: o.userText,
      tools: toolDefs,
      mode: o.mode,
      steer: () => {
        try {
          const got = o.lease.drain();
          steered.push(...got);
          return got;
        } catch {
          return [];
        }
      },
      // a message sent meanwhile ends a wait for a k-skill login (the steer then reaches the model)
      steerPending: () => {
        try {
          return (o.lease.pending?.() ?? 0) > 0;
        } catch {
          return false;
        }
      },
      // only a person typing in the app waits for a connect (voice, phone, scheduled and follow-up turns don't)
      ...(o.initiatedBy === "user" && o.mode === "text" && !othersPresent && core.cfg.connectionWaitMs > 0 ? { connectionWaitMs: core.cfg.connectionWaitMs } : {}),
      ...(o.resume ? { resume: { call: o.resume.call, decision: o.resume.decision, priorMessages: o.resume.priorMessages } } : {}),
    };

    if (!deps.runTurn) throw Object.assign(new Error("llm not configured"), { name: "UpstreamError", status: 503 });
    armIdle();
    const aborted = new Promise<never>((_, reject) => {
      if (ac.signal.aborted) reject(ac.signal.reason);
      ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
    });
    promptChars = system.length + JSON.stringify(history).length + (o.userText?.length ?? 0);
    runPromise = deps.runTurn(input, emit);
    outcome = await Promise.race([runPromise, aborted]);
    mark("run");
  } catch (err) {
    failure = err;
  } finally {
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    o.signal?.removeEventListener("abort", onClientGone);
  }

  const clientGone = !!o.signal?.aborted && !timedOut;
  // A server-side abort (idle timeout, max time, Stop) wins the race before runTurn has unwound, so
  // the partial outcome it attaches on the way out (tools that already ran) isn't there yet. Give it
  // the settle window first: otherwise a timed-out turn's completed actions never reach history and
  // the next turn repeats them (a second artifact, a second send).
  let runFailure: unknown = null;
  if (!outcome && failure && runPromise) runFailure = await settledRejection(runPromise, core.cfg.turnSettleMs);
  let result: TurnResult = { message: null, error: null, aborted: clientGone };
  try {
    // ───── persist ─────
    const now = core.now();
    let finalText: string;
    let finalCards: Card[];
    let finalTools: ToolActivity[];
    let llm: LlmMessage[] | null;
    let totalTokens = 0;
    const partial = !outcome && failure ? ((runFailure ? deps.partialOutcome?.(runFailure) : null) ?? deps.partialOutcome?.(failure) ?? null) : null;
    if (outcome) {
      finalText = typeof outcome.text === "string" ? outcome.text : text;
      finalCards = Array.isArray(outcome.cards) ? outcome.cards.map(swapCard) : cards;
      finalTools = Array.isArray(outcome.tools) ? outcome.tools : [...tools.values()];
      llm = Array.isArray(outcome.messages) ? outcome.messages : null;
      totalTokens = billable(outcome.usage);
    } else {
      const partialText = typeof partial?.text === "string" && partial.text.trim() ? partial.text : "";
      finalText = partialText || text;
      finalCards = partial?.cards?.length ? partial.cards.map(swapCard) : cards;
      const seenTools = partial?.tools?.length ? partial.tools : [...tools.values()];
      finalTools = seenTools.map((t) => (t.state === "running" ? { ...t, state: "error" as const, summary: t.summary ?? "중단됐어요", endedAt: now } : t));
      // what already happened (e.g. an approved send that ran before the follow-up call failed)
      // must reach history, or the model will offer to do it again
      if (partial?.messages?.length) llm = partial.messages;
      else llm = finalText.trim() ? [{ role: "assistant", content: finalText }] : null;
      totalTokens = billable(partial?.usage);
      // no usage report for an aborted/failed turn: if the model demonstrably answered (text or
      // tool calls), charge an estimate so cancelling mid-turn can't bypass the daily quota
      if (!totalTokens && runPromise && (text.trim() || tools.size)) {
        totalTokens = estimateTokens(promptChars) * (1 + tools.size) + estimateTokens(text.length);
      }
      if (!clientGone) {
        result.error = classifyError(failure, timedOut);
        log.warn("turn failed", { user: o.userId, thread: o.threadId, err: errInfo(failure), timedOut });
      } else {
        log.info("turn aborted by client", { user: o.userId, thread: o.threadId });
      }
    }

    const pending = outcome?.pendingApproval;
    let approvalId: string | null = null;
    if (pending) {
      approvalId = approvalIdFor(pending.call.id);
      finalCards = ensureApprovalCard(finalCards, approvalId, pending.spec);
    }
    if (outcome?.pendingCredential) finalCards = ensureCredentialCard(finalCards, outcome.pendingCredential);
    // k-skill login cards: connected after the turn's wait (no await from here to the insert, see kskill.ts)
    finalCards = loginCards.settle(finalCards);

    const produced = finalText.trim().length > 0 || finalCards.length > 0 || finalTools.length > 0;
    const bare = !finalText.trim() && !finalCards.length;
    // Stopped with something on screen: keep what the model would replay (partial text, tools that already ran) AND
    // say the request was stopped; with nothing replayable (stopped mid-tool) the cancel note is the row's history.
    // Partial text alone used to stay note-less, and a cut-off list read as an accident: after "고마워" the model
    // picked it back up ("끊겼네요, 이어서 적어 드릴게요") in 3–4/20 real stop → 고마워 runs.
    // (the rest of the Stop handling runs in `finally`, once late steers are drained too)
    if (clientGone && !outcome && produced && !hasCancelNote(llm)) llm = [...(llm ?? []), CANCEL_NOTE_MESSAGE];
    if (produced && !(o.dropBareRow && bare)) {
      db.tx(() => {
        db.insertMessage({
          id: messageId,
          threadId: o.threadId,
          role: "assistant",
          text: finalText,
          cards: finalCards,
          tools: finalTools,
          authorUserId: isFriend ? o.userId : null,
          authorKind: isFriend ? "agent" : null,
          llm,
          createdAt: Math.max(now, startedAt + 1),
        });
        if (pending && approvalId) {
          db.insertApproval({
            id: approvalId,
            userId: o.userId,
            threadId: o.threadId,
            messageId,
            callJson: JSON.stringify(pending.call),
            priorJson: JSON.stringify(pending.messages ?? []),
            specJson: JSON.stringify(pending.spec),
            now,
            expiresAt: now + APPROVAL_TTL_MS,
          });
        }
        db.addUsage(o.userId, quotaDay(now), totalTokens);
        const subtitle = KIND_SUBTITLE_FIXED.includes(thread.kind) || !finalText.trim() ? undefined : preview(finalText);
        db.touchThread(o.threadId, now, subtitle);
        for (const uid of db.threadMembers(o.threadId)) {
          if (uid !== o.userId || o.initiatedBy === "system") db.setUnread(o.threadId, uid, true);
        }
      });
      const row = db.getMessage(messageId) as MessageRow;
      result.message = messageView(core, row, o.userId);
    } else if (totalTokens > 0) {
      db.addUsage(o.userId, quotaDay(now), totalTokens);
    }

    if (result.error) o.sink({ type: "error", ...result.error });
    else if (result.message) o.sink({ type: "done", message: result.message, quota: quotaFor(core, o.userId) });
    else if (!clientGone) {
      result.error = { error: "empty_reply", message: "답을 만들지 못했어요. 다시 한번 말해 주세요." };
      o.sink({ type: "error", ...result.error });
    }

    if (result.message) {
      // other members (friend threads) and other tabs of the same user
      publishMessage(core, messageId, { exclude: o.initiatedBy === "user" && !result.error ? o.userId : undefined });
      publishThread(core, o.threadId);
      core.events.publish(o.userId, { type: "quota", quota: quotaFor(core, o.userId) });
    }
    log.info("turn done", {
      user: o.userId,
      thread: o.threadId,
      ms: core.now() - startedAt,
      usage: totalTokens,
      tools: finalTools.length,
      phases: phases.join(" "),
      approval: approvalId ? 1 : 0,
      error: result.error?.error ?? null,
    });

    if (outcome && finalText.trim()) core.track(afterTurn(core, { user, thread, userText: o.userText, assistantText: finalText, memory: settings.privacy.memoryEnabled }));
  } catch (err) {
    log.error("turn persist failed", { user: o.userId, thread: o.threadId, err: errInfo(err) });
    result = { message: result.message, error: { error: "internal", message: "답을 저장하지 못했어요. 다시 시도해 주세요." }, aborted: clientGone };
    o.sink({ type: "error", ...result.error! });
  } finally {
    loginCards.done();
    // No stream carries this error (a system turn, a steer follow-up) but the person's lines went into the turn: they
    // see it under them, as after a turn of their own (the app's thread error, like a stream's "error" event)
    const turnError = o.initiatedBy === "system" && (o.forSteered || steered.length) ? result.error : null;
    if (turnError) {
      try {
        core.events.publish(o.userId, { type: "turn_error", threadId: o.threadId, error: turnError.error, message: turnError.message });
      } catch {
        /* ignore */
      }
    }
    if (!outcome && runPromise) {
      // aborted while runTurn (maybe a tool: a call, a messenger send) is still going: give it a
      // moment to wind down so the next turn doesn't overlap with it
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runPromise.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((res) => (timer = setTimeout(res, core.cfg.turnSettleMs))),
      ]);
      clearTimeout(timer);
    }
    let leftovers: string[] = [];
    try {
      leftovers = o.lease.drain();
    } catch {
      leftovers = [];
    }
    // The lines a turn ends without answering: every device of the person hears their rows, so the one that sent a line
    // drops its receipt (the device that stopped the turn or held its stream may be another one, or the island's retry,
    // a delegate sheet). A turn the app started, stopped: all lines steered into it, there is no follow-up after a Stop.
    // Failed (the app's turn, or one with a turn_error above: a briefing, a schedule, a follow-up): the lines it took
    // in, the oldest (the launcher's queue is first in, first out), and a follow-up's own lines; the lines still queued
    // get their follow-up turn
    let ids: string[] = [];
    try {
      ids = (o.lease as Partial<HeldLease>).steeredIds?.() ?? [];
    } catch {
      ids = [];
    }
    const read = ids.slice(0, Math.max(0, ids.length - leftovers.length));
    let dropped: string[] = [];
    if (o.initiatedBy === "user" && clientGone) dropped = ids;
    else if (o.initiatedBy === "user" && result.error) dropped = read;
    else if (turnError) dropped = [...(o.forSteered ?? []), ...read];
    if (clientGone) {
      // Stop = stop everything in flight for this thread: steered/leftover messages get no
      // follow-up turn, and the model learns they were cancelled. Done before release, so no new
      // turn can read the history in between.
      try {
        cancelInHistory(core, o, result.message ? messageId : null, !!outcome);
      } catch (err) {
        log.warn("cancel note failed", { user: o.userId, thread: o.threadId, err: errInfo(err) });
      }
      leftovers = [];
    }
    if (dropped.length) {
      try {
        core.events.publish(o.userId, { type: "steers_dropped", threadId: o.threadId, messageIds: dropped });
      } catch {
        /* ignore */
      }
    }
    try {
      o.lease.release();
    } catch {
      /* ignore */
    }
    try {
      deps.launcher.setStatus(o.userId, "idle");
    } catch {
      /* ignore */
    }
    core.events.publish(o.userId, { type: "agent_status", status: "idle" });
    if (leftovers.length) core.track(steerFollowUp(core, o.userId, o.threadId, leftovers, ids.slice(read.length)));
  }
  return result;
}

/**
 * After Stop, put one CANCEL_NOTE after the last thing the model would replay from this turn:
 *  - steered user messages (drained or still queued) → after the last of them, or after this
 *    turn's assistant row when that row comes later (its partial output included the steers);
 *  - no steers, nothing produced → on the request row (user/event row or paused approval);
 *  - no steers but partial output → already on this turn's assistant row (persist adds it), so unchanged;
 *  - a completed turn → unchanged (it has its own history).
 * Bubbles are never added or hidden; only llm_json changes.
 */
function cancelInHistory(core: Core, o: ExecuteTurnOptions, assistantRowId: string | null, completed: boolean): void {
  const reqId = o.resume ? o.resume.pausedMessageId : o.historyBeforeId;
  if (!reqId) return;
  let target: MessageRow | null = null;
  let steered = 0;
  for (const r of core.db.messagesAfter(o.threadId, reqId)) {
    if (r.role === "user" && r.steered) {
      target = r;
      steered++;
    } else if (r.id === assistantRowId) target = r;
  }
  if (!target) {
    if (!completed && !assistantRowId) markCancelled(core, o);
    return;
  }
  if (target.id === assistantRowId) {
    if (completed || steered === 0) return;
    appendCancelNote(core, target, []);
    return;
  }
  appendCancelNote(core, target, [{ role: "user", content: target.text }]);
}

function appendCancelNote(core: Core, row: MessageRow, fallback: LlmMessage[]): void {
  const parsed = safeJson<unknown>(row.llm_json, null);
  const llm = Array.isArray(parsed) ? (parsed as LlmMessage[]) : null;
  if (hasCancelNote(llm)) return;
  core.db.setMessageLlm(row.id, [...(llm ?? fallback), CANCEL_NOTE_MESSAGE]);
}

/**
 * Nothing was produced before the user stopped the turn: attach the cancel note to the row that
 * carries the request (the user/event row, or the paused approval message on resume).
 */
function markCancelled(core: Core, o: ExecuteTurnOptions): void {
  const id = o.resume ? o.resume.pausedMessageId : o.historyBeforeId;
  if (!id) return;
  const row = core.db.getMessage(id);
  if (!row) return;
  const parsed = safeJson<unknown>(row.llm_json, null);
  const llm = Array.isArray(parsed) ? (parsed as LlmMessage[]) : null;
  if (hasCancelNote(llm)) return;
  // resume: the paused row's [] meant "nothing yet"; user/event rows keep their request
  const base: LlmMessage[] = o.resume ? (llm ?? []) : (llm ?? [{ role: "user", content: row.text }]);
  core.db.setMessageLlm(id, [...base, CANCEL_NOTE_MESSAGE]);
}

/** Async post-turn work: daily log, memory extraction, auto title. Never throws. */
async function afterTurn(
  core: Core,
  a: { user: UserRow; thread: ThreadRow; userText: string | null; assistantText: string; memory: boolean },
): Promise<void> {
  const { deps, log } = core;
  const at = new Date(core.now());
  try {
    await deps.launcher.appendDaily(a.user.id, { user: a.userText ?? "(승인 후 이어서 진행)", assistant: a.assistantText, at });
  } catch (err) {
    log.warn("appendDaily failed", { user: a.user.id, err: errInfo(err) });
  }
  if (deps.llm && a.memory && a.userText && a.thread.kind !== "friend") {
    try {
      const existing = (await deps.launcher.listMemories(a.user.id)).map((m) => m.text);
      const facts = await deps.llm.extractMemories({ userText: a.userText, assistantText: a.assistantText, existing });
      for (const fact of facts.slice(0, 3)) {
        if (typeof fact !== "string" || !fact.trim()) continue;
        try {
          // the launcher refuses secret-looking text (card numbers, passwords…) by throwing
          await deps.launcher.remember(a.user.id, fact.trim());
        } catch (err) {
          log.info("memory skipped", { user: a.user.id, reason: err instanceof Error ? err.name : "error" });
          continue;
        }
        core.events.publish(a.user.id, { type: "notification", title: "기억했어요", body: fact.trim(), threadId: a.thread.id, icon: "sparkles" });
      }
    } catch (err) {
      log.warn("memory extraction failed", { user: a.user.id, err: errInfo(err) });
    }
  }
  if (deps.llm && a.thread.kind === "task" && a.thread.auto_title === 1 && a.userText) {
    try {
      const title = (await deps.llm.titleFor(a.userText)).trim().slice(0, 40);
      if (title) {
        core.db.setThreadTitle(a.thread.id, title);
        publishThread(core, a.thread.id);
      }
    } catch (err) {
      log.warn("title failed", { user: a.user.id, err: errInfo(err) });
    }
  }
}

/**
 * Steered texts that arrived after the agent's last steer poll get their own turn (`rows`: their message rows, oldest
 * first). Over the day's quota it never runs: the person sees the quota message under the lines (`turn_error`, what a
 * send of theirs gets now), and the lines lose their steer receipt (`steers_dropped`), as after a failed follow-up. A
 * thread that is gone gets nothing (no screen shows it).
 */
async function steerFollowUp(core: Core, userId: string, threadId: string, texts: string[], rows: string[]): Promise<void> {
  const lease = holdLease(core, userId, threadId, await core.deps.launcher.acquire(userId));
  if (!core.db.threadFor(threadId, userId)) {
    lease.release();
    return;
  }
  if (quotaExceeded(core, userId)) {
    lease.release();
    core.log.info("follow-up turn skipped: daily quota", { user: userId, thread: threadId, lines: texts.length });
    try {
      core.events.publish(userId, { type: "turn_error", threadId, error: "quota_exceeded", message: QUOTA_MESSAGE });
      if (rows.length) core.events.publish(userId, { type: "steers_dropped", threadId, messageIds: rows });
    } catch {
      /* ignore */
    }
    return;
  }
  await executeTurn(core, {
    userId,
    threadId,
    userText: texts.join("\n"),
    userMessage: null,
    mode: "text",
    lease,
    sink: () => {},
    initiatedBy: "system",
    historyExcludeTexts: new Set(texts),
    forSteered: rows,
  });
}

/**
 * System-initiated turn (schedules, daily briefing): stores an `event` row carrying the prompt
 * (replayed to the LLM as the user turn), runs the agent, and notifies the user.
 *
 * `retryable` (the daily briefing, which the scheduler tries again): an attempt that leaves no text and no card leaves
 * nothing behind. No assistant row (dropBareRow), its event row is deleted, no notification. The event row is shown
 * only together with an answer (published right before it), so a failed attempt puts no "오늘의 브리핑" chip on an
 * open screen either; the row is still inserted first, so the answer and any line steered into the turn sort after it.
 * A screen that loaded the thread while the attempt ran has the row from that page: the delete tells it to drop it.
 */
export async function runSystemTurn(
  core: Core,
  o: {
    userId: string;
    threadId: string;
    prompt: string;
    eventText: string;
    lease: LeaseLike;
    notify?: { title: string; icon: IconName; enabled: boolean };
    retryable?: boolean;
    /** id for the event row (the scheduler records it before the turn) */
    eventId?: string;
  },
): Promise<TurnResult> {
  const eventId = o.eventId ?? newId("m");
  core.db.insertMessage({
    id: eventId,
    threadId: o.threadId,
    role: "event",
    text: o.eventText,
    llm: [{ role: "user", content: o.prompt }],
    createdAt: core.now(),
  });
  let shown = !o.retryable;
  const show = () => {
    if (shown) return;
    shown = true;
    publishMessage(core, eventId);
  };
  if (!o.retryable) publishMessage(core, eventId);
  let res: TurnResult;
  try {
    const eventMsg = messageView(core, core.db.getMessage(eventId) as MessageRow, o.userId);
    res = await executeTurn(core, {
      userId: o.userId,
      threadId: o.threadId,
      userText: o.prompt,
      userMessage: eventMsg,
      mode: "text",
      lease: o.lease,
      // "done" comes after the answer is stored and before it is published
      sink: o.retryable ? (e) => void (e.type === "done" && show()) : () => {},
      initiatedBy: "system",
      historyBeforeId: eventId,
      ...(o.retryable ? { dropBareRow: true } : {}),
    });
  } catch (err) {
    // a throw after the answer was stored keeps the row with it
    if (o.retryable && !answeredAfter(core, o.threadId, eventId)) deleteMessageRow(core, eventId);
    throw err;
  }
  if (o.retryable) {
    // an answer stored with an error (text, then a 429) gets no "done": show its chip now
    if (res.message) show();
    else deleteMessageRow(core, eventId);
  }
  if (o.notify?.enabled && res.message) {
    core.events.publish(o.userId, {
      type: "notification",
      title: o.notify.title,
      body: preview(res.message.text || "새 소식이 있어요", 80),
      threadId: o.threadId,
      icon: o.notify.icon,
    });
  }
  return res;
}

/**
 * Deletes a message row (a failed briefing attempt's event row, never published, but in the messages page of an app that
 * loaded the thread while the attempt ran) and tells every member's open apps: `message_deleted`, then `thread_updated`,
 * as the list row's preview may have shown the row's note.
 */
export function deleteMessageRow(core: Core, id: string): void {
  const row = core.db.getMessage(id);
  if (!row) return;
  core.db.sql.query("DELETE FROM messages WHERE id = $id").run({ id });
  for (const uid of core.db.threadMembers(row.thread_id)) core.events.publish(uid, { type: "message_deleted", threadId: row.thread_id, messageId: id });
  publishThread(core, row.thread_id);
}

/**
 * Did this system turn's event row get its answer: an assistant row after it, before the next request (the person's
 * line that wasn't steered into the turn, or another system turn's event row)? False when the event row is gone.
 */
export function answeredAfter(core: Core, threadId: string, eventId: string): boolean {
  for (const r of core.db.messagesAfter(threadId, eventId)) {
    if (r.role === "assistant") return true;
    if ((r.role === "user" && !r.steered) || isSystemRequest(r)) return false;
  }
  return false;
}

/** SSE response that runs `executeTurn` and closes when it finishes or the client leaves. */
export function streamTurn(core: Core, c: Ctx, opts: Omit<ExecuteTurnOptions, "sink" | "signal">): Response {
  let ch: SseChannel;
  try {
    ch = new SseChannel(core.cfg.sseHeartbeatMs, c.req.signal);
  } catch (err) {
    opts.lease.release();
    throw err;
  }
  try {
    c.server?.timeout?.(c.req, 0);
  } catch {
    /* older Bun */
  }
  const gone = new AbortController();
  ch.onClose(() => gone.abort());
  const run = executeTurn(core, { ...opts, sink: (e) => void ch.send(e), signal: gone.signal })
    .catch((err) => {
      core.log.error("turn crashed", { err: errInfo(err) });
      ch.send({ type: "error", error: "internal", message: "처리 중에 문제가 생겼어요. 다시 시도해 주세요." });
    })
    .finally(() => ch.close());
  core.track(run);
  return ch.response();
}

/** The draft's status line while a queued send waits; repeated so the app's 15 s stall cue stays off. */
export const QUEUED_STATUS = "하던 일을 마치면 바로 시작할게요";
const QUEUED_STATUS_EVERY_MS = 10_000;
/** Sends waiting behind a running turn, per user; past this a send is 409 busy as before. */
export const MAX_QUEUED_TURNS = 3;
const queuedByCore = new WeakMap<Core, Map<string, number>>();

/** How many sends of this user wait for the agent right now (streamQueuedTurn). */
export function queuedTurns(core: Core, userId: string): number {
  return queuedByCore.get(core)?.get(userId) ?? 0;
}

/**
 * SSE response for a send that has to wait for the user's agent (it works in another thread, a schedule or a
 * briefing). The stream answers at once: `prepare()` stores the user row, then `start {userMessage, messageId}` and
 * the QUEUED_STATUS line every 10 s. The launcher's lease is FIFO, so the turn starts right after the running one (and
 * any send queued before it), with the same `messageId`, and streams as usual.
 * A client that leaves while queued has pressed Stop: nothing runs, and the request row gets the cancel note, exactly
 * like Stop on a turn that produced nothing yet.
 */
export function streamQueuedTurn(
  core: Core,
  c: Ctx,
  opts: Omit<ExecuteTurnOptions, "sink" | "signal" | "lease" | "userMessage" | "announcedMessageId">,
  prepare: () => Message,
): Response {
  const ch = new SseChannel(core.cfg.sseHeartbeatMs, c.req.signal); // throws before anything is stored or queued
  let userMessage: Message;
  try {
    userMessage = prepare();
  } catch (err) {
    ch.close();
    throw err;
  }
  try {
    c.server?.timeout?.(c.req, 0);
  } catch {
    /* older Bun */
  }
  const gone = new AbortController();
  ch.onClose(() => gone.abort());
  const messageId = newId("m");
  ch.send({ type: "start", threadId: opts.threadId, userMessage, messageId });
  ch.send({ type: "status", text: QUEUED_STATUS });
  const repeat = setInterval(() => void ch.send({ type: "status", text: QUEUED_STATUS }), QUEUED_STATUS_EVERY_MS);
  const counts = queuedByCore.get(core) ?? new Map<string, number>();
  queuedByCore.set(core, counts);
  counts.set(opts.userId, (counts.get(opts.userId) ?? 0) + 1);
  core.log.info("turn queued", { user: opts.userId, thread: opts.threadId });

  const run = (async () => {
    let raw: LeaseLike;
    try {
      raw = await core.deps.launcher.acquire(opts.userId);
    } finally {
      clearInterval(repeat);
      const n = (counts.get(opts.userId) ?? 1) - 1;
      if (n > 0) counts.set(opts.userId, n);
      else counts.delete(opts.userId);
    }
    const lease = holdLease(core, opts.userId, opts.threadId, raw);
    const turn: ExecuteTurnOptions = { ...opts, userMessage, announcedMessageId: messageId, lease, sink: (e) => void ch.send(e), signal: gone.signal };
    if (gone.signal.aborted) {
      try {
        markCancelled(core, turn);
      } catch (err) {
        core.log.warn("cancel note failed", { user: opts.userId, thread: opts.threadId, err: errInfo(err) });
      }
      lease.release();
      return;
    }
    // the turn it waited for may have used up the day's quota
    if (quotaExceeded(core, opts.userId)) {
      lease.release();
      ch.send({ type: "error", error: "quota_exceeded", message: QUOTA_MESSAGE });
      return;
    }
    await executeTurn(core, turn);
  })()
    .catch((err) => {
      core.log.error("turn crashed", { err: errInfo(err) });
      ch.send({ type: "error", error: "internal", message: "처리 중에 문제가 생겼어요. 다시 시도해 주세요." });
    })
    .finally(() => ch.close());
  core.track(run);
  return ch.response();
}

/** Parse stored JSON helpers for approvals. */
export function parseCall(json: string): LlmToolCall | null {
  const c = safeJson<LlmToolCall | null>(json, null);
  return c && typeof c.id === "string" && c.function && typeof c.function.name === "string" ? c : null;
}
