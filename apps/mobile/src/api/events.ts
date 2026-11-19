import type { ID, ServerEvent } from "@pickle/protocol";
import { island } from "../app/island";
import { koreanMessage } from "./client";
import { eventsUrl } from "./endpoints";
import { appendMessage, failRemoteTurn, noteRemoteActivity, removeMessage, setQuota, setRemoteAgentStatus, upsertConnection, upsertThread } from "./store";

/**
 * Server push (GET /api/events?token= — EventSource has no headers; `: connected` / `: hb` comments are ignored by
 * EventSource). Reconnects with exponential backoff (1 s → 30 s, ±20 % jitter), resets on `hello`, sleeps after 60 s
 * in a hidden tab and wakes on visible/online. Events fold into the stores:
 *   message (other tabs, friend side, steer follow-ups, schedule turns, card status flips) · message_deleted (a row the
 *   server deleted: a failed briefing attempt's event row) · thread_updated ·
 *   agent_status (→ island when no local turn runs) · quota · notification (→ island banner) · connection ·
 *   turn_error (a turn the person's steered line went into failed → thread error; island 다시 시도 on the device that
 *   sent the line). steers_dropped goes to screens/chat/composerStore through onServerEvent (lines steered into an app turn
 *   that stopped or failed, which nothing will answer, lose "하던 일에 이어서 전했어요").
 */

const listeners = new Set<(e: ServerEvent) => void>();
/** Screens subscribe to raw server events (e.g. a connection sheet waiting for `connection`). */
export function onServerEvent(fn: (e: ServerEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let openThread: ((threadId: ID) => void) | null = null;
/** The shell injects navigation so a tapped notification banner (or the busy island) opens its thread. */
export function setOpenThreadHandler(fn: ((threadId: ID) => void) | null): void {
  openThread = fn;
  island.setHandlers({ open: (threadId) => (threadId ? openThread?.(threadId) : undefined) });
}

let es: EventSource | null = null;
let wanted = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let pausedForHidden = false;
let lifecycleBound = false;

const MIN_DELAY = 1_000;
const MAX_DELAY = 30_000;
const HIDDEN_SLEEP = 60_000;

function dispatch(e: ServerEvent) {
  switch (e.type) {
    case "hello":
      attempt = 0;
      break;
    case "thread_updated":
      upsertThread(e.thread);
      noteRemoteActivity();
      break;
    case "message":
      appendMessage(e.threadId, e.message);
      noteRemoteActivity();
      break;
    case "message_deleted":
      removeMessage(e.threadId, e.messageId);
      break;
    case "notification": {
      const threadId = e.threadId;
      island.banner({
        icon: e.icon,
        title: e.title,
        body: e.body,
        onPress: threadId && openThread ? () => openThread?.(threadId) : undefined,
      });
      break;
    }
    case "quota":
      setQuota(e.quota);
      break;
    case "connection":
      upsertConnection(e.connection);
      break;
    case "agent_status":
      setRemoteAgentStatus(e.status, e.text);
      break;
    case "turn_error": {
      const threadId = e.threadId;
      // their line isn't on this device (thread not loaded here): an error banner that opens the thread instead
      if (!failRemoteTurn(threadId, e.error, e.message))
        island.banner({ icon: "bolt", tone: "error", title: "답하지 못했어요", body: e.message || koreanMessage(0, e.error), onPress: openThread ? () => openThread?.(threadId) : undefined });
      break;
    }
  }
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch {
      /* a screen's listener must not break the stream */
    }
  }
}

function close() {
  if (es) {
    es.onmessage = null;
    es.onerror = null;
    es.close();
    es = null;
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (!wanted || pausedForHidden) return;
  const base = Math.min(MAX_DELAY, MIN_DELAY * 2 ** attempt);
  const delay = base * (0.8 + Math.random() * 0.4);
  attempt = Math.min(attempt + 1, 10);
  retryTimer = setTimeout(open, delay);
}

function open() {
  clearTimeout(retryTimer);
  if (!wanted || es || pausedForHidden || typeof EventSource === "undefined") return;
  const url = eventsUrl();
  if (!url) return;
  const source = new EventSource(url);
  es = source;
  source.onmessage = (m: MessageEvent<string>) => {
    let e: ServerEvent;
    try {
      e = JSON.parse(m.data) as ServerEvent;
    } catch {
      return;
    }
    if (e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string") dispatch(e);
  };
  source.onerror = () => {
    // take over from the browser's own retry so backoff and auth checks are ours
    if (es !== source) return;
    close();
    scheduleRetry();
  };
}

function onVisibility() {
  if (!wanted) return;
  if (document.hidden) {
    clearTimeout(hiddenTimer);
    hiddenTimer = setTimeout(() => {
      if (document.hidden) {
        pausedForHidden = true;
        clearTimeout(retryTimer);
        close();
      }
    }, HIDDEN_SLEEP);
  } else {
    clearTimeout(hiddenTimer);
    if (pausedForHidden || !es) {
      pausedForHidden = false;
      attempt = 0;
      open();
    }
  }
}

function onOnline() {
  if (!wanted || es) return;
  attempt = 0;
  open();
}

function bindLifecycle() {
  if (lifecycleBound || typeof document === "undefined") return;
  lifecycleBound = true;
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
}

/** Open the live event stream for the current token (idempotent). */
export function connectEvents(): void {
  wanted = true;
  bindLifecycle();
  if (typeof document !== "undefined" && document.hidden) {
    onVisibility();
    if (pausedForHidden) return;
  }
  open();
}

/** Close the stream and stop reconnecting (logout). */
export function disconnectEvents(): void {
  wanted = false;
  pausedForHidden = false;
  attempt = 0;
  clearTimeout(retryTimer);
  clearTimeout(hiddenTimer);
  close();
}

export const eventsConnected = () => !!es && es.readyState === 1;
