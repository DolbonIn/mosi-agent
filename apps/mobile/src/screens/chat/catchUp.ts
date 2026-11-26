import type { ID, Thread } from "@pickle/protocol";
import { useEffect, useRef } from "react";
import { onServerEvent } from "../../api/events";
import { markThreadsStale, messagesStore, noteHello, refreshThreads, threadsStore, useThread } from "../../api/store";

/**
 * Catching up after a reconnect (DD 2259 §6, 0327). The server does not replay events sent while this device was away
 * (a hidden tab's stream sleeps after 60 s; a network drop): every `hello` but the first since sign-in (store noteHello)
 * reads the thread list again (refreshThreads), then marks every thread whose pages are held stale; a thread view on
 * screen reads its first page again at once, any other when it is next on screen (store refreshRecent). Hidden, it
 * waits until the page is visible: reading a thread's first page clears its unread mark on the server, so it is read
 * only when seen, and several reconnects while hidden make one catch-up. Reads that overlap merge safely (store), so
 * nothing waits on an earlier one. events.ts is left as it is.
 */

/** threads whose view is on screen now (ThreadView `active`): they stay read in the merged list */
const shown = new Set<ID>();
/** a reconnect came while hidden: catch up once the page is visible (however many came meanwhile) */
let waiting = false;

const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
/** nothing held yet (no list, no thread read): the first reads are still to come, there is nothing to catch up */
const holding = () => threadsStore.get().loaded || Object.values(messagesStore.get()).some((t) => t.loaded);

async function catchUp() {
  if (!holding()) return;
  await refreshThreads(shown);
  markThreadsStale();
}

function onVisible() {
  if (!visible()) return;
  document.removeEventListener("visibilitychange", onVisible);
  waiting = false;
  void catchUp();
}

onServerEvent((e) => {
  if (e.type !== "hello" || !noteHello()) return;
  if (visible()) void catchUp();
  else if (!waiting && typeof document !== "undefined") {
    waiting = true;
    document.addEventListener("visibilitychange", onVisible);
  }
});

/** ThreadView: this thread is on screen while `active` */
export function useShownThread(threadId: ID, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    shown.add(threadId);
    return () => {
      shown.delete(threadId);
    };
  }, [threadId, active]);
}

/**
 * The thread for a screen that has it open. A thread the re-read list leaves out (deleted, unfriended while away) goes
 * from the drawer, but a screen showing it keeps its last copy, so it doesn't fall away under the person (DD 0327, as
 * with archiving elsewhere: DD 2103 §2).
 */
export function useKeptThread(threadId: ID | null | undefined): Thread | undefined {
  const thread = useThread(threadId);
  const kept = useRef<Thread | undefined>(undefined);
  if (thread) kept.current = thread;
  return thread ?? (kept.current && kept.current.id === threadId ? kept.current : undefined);
}
