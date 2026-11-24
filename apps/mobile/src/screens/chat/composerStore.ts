import type { ID } from "@pickle/protocol";
import { onServerEvent } from "../../api/events";
import { isTempId, messagesStore, type SendResult } from "../../api/store";
import { createStore, useStore } from "../../lib/createStore";

/**
 * Per-thread composer text that survives tab switches and pushes, plus the focus request that suggestion chips and
 * nav.compose use ("put this text in the composer and focus it"). Chat-screen state only.
 */
interface ComposerState {
  text: Record<ID, string>;
  /** bumps when something asks the composer of `focusThread` to focus */
  focusSeq: number;
  focusThread: ID | null;
}

export const composerStore = createStore<ComposerState>({ text: {}, focusSeq: 0, focusThread: null });

export const useComposerText = (threadId: ID) => useStore(composerStore, (s) => s.text[threadId] ?? "", Object.is);

export function setComposerText(threadId: ID, text: string) {
  const s = composerStore.get();
  if ((s.text[threadId] ?? "") === text) return;
  composerStore.patch({ text: { ...s.text, [threadId]: text } });
}

export function requestComposerFocus(threadId: ID, text?: string) {
  if (text !== undefined) setComposerText(threadId, text);
  const s = composerStore.get();
  composerStore.patch({ focusSeq: s.focusSeq + 1, focusThread: threadId });
}

/** when each thread's current turn started (performance.now()) — the first-token timeline counts from here */
export const turnStarted = new Map<ID, number>();
/** user messages the server steered into a running turn (202) / delivered to a friend thread (201) */
export type Receipt = "steered" | "delivered";
const receipts = createStore<Record<ID, Receipt>>({});
export function markReceipt(id: ID, kind: Receipt) {
  // its turn already stopped or failed (the server's `steers_dropped` came before this 202): nothing will answer it
  if (droppedSteers.has(id)) return;
  receipts.set((s) => ({ ...s, [id]: kind }));
}
export const useReceipt = (id: ID) => useStore(receipts, (s) => s[id], Object.is);
export const receiptOf = (id: ID): Receipt | undefined => receipts.get()[id];
/** the receipts map itself: ThreadView looks again when a 202 lands after the turn it steered into already failed */
export const useReceipts = () => useStore(receipts, (s) => s, Object.is);

/**
 * The steered lines a failed or stopped turn left unanswered (the error row of a turn the app did not start is up:
 * `failedRemotely`; or a turn sent from there came back stopped; a call's transcript asks the same of its lines).
 * `rows` = the thread's messages as [id, role], oldest first.
 *  - lines after the last reply: the failed turn is the one they went into (the person's turn, a briefing, a schedule)
 *  - none there, and no line of the person's after that reply either: the reply is the failed turn's partial answer
 *    (the server dates it at the end, after the lines it streamed past) or a finished one whose steered lines were
 *    left to a follow-up turn, the turn that failed. Then the steered lines just before it, back to the line that
 *    started that turn (one with no steer receipt), an event row or an earlier reply
 */
export function unansweredSteers(rows: ReadonlyArray<readonly [ID, string]>, steered: (id: ID) => boolean): ID[] {
  let last = rows.length - 1;
  while (last >= 0 && rows[last]![1] !== "assistant") last--;
  const tail = rows.slice(last + 1);
  const after = tail.filter(([id, role]) => role === "user" && steered(id)).map(([id]) => id);
  if (after.length || last < 0 || tail.some(([, role]) => role === "user")) return after;
  const before: ID[] = [];
  for (let i = last - 1; i >= 0; i--) {
    const [id, role] = rows[i]!;
    if (role !== "user" || !steered(id)) break;
    before.unshift(id);
  }
  return before;
}

type Row = { id: ID; role: string };
/** the rows the server has (a line still being sent is not one) */
const rowsOf = (items: readonly Row[]) => items.filter((m) => !isTempId(m.id)).map((m) => [m.id, m.role] as const);

/**
 * A thread whose turn failed with nothing of theirs left unsent (its error row is up), a turn the app did not start
 * (`failedRemotely`): the steered lines that turn left unanswered. The call's transcript asks this of its own lines.
 */
export function failedTurnSteers(threadId: ID, t: { error?: string; failed: readonly ID[]; streaming: boolean; items: readonly Row[] } | undefined, steered: (id: ID) => boolean): ID[] {
  if (!t?.error || t.failed.length || t.streaming || !remoteFailed.has(threadId)) return [];
  return unansweredSteers(rowsOf(t.items), steered);
}

/**
 * A send that came back stopped after its turn had started (멈추기, or the island's): the server answers none of the
 * lines steered into that turn (no follow-up turn after a Stop), so they lose their receipt, as after a failure.
 */
export function dropStoppedSteers(r: Pick<SendResult, "status" | "accepted">, items: readonly Row[]) {
  if (r.status === "aborted" && r.accepted) dropUnansweredSteers(rowsOf(items));
}

/** a failed or stopped turn's unanswered steered lines lose "하던 일에 이어서 전했어요" for good: it would read as handled */
export function dropUnansweredSteers(rows: ReadonlyArray<readonly [ID, string]>) {
  const s = receipts.get();
  forget(unansweredSteers(rows, (id) => s[id] === "steered"));
}
function forget(ids: readonly ID[]) {
  if (!ids.length) return;
  receipts.set((p) => {
    const next = { ...p };
    for (const id of ids) delete next[id];
    return next;
  });
}

/**
 * Lines steered into a turn the app started that will never answer them: it stopped after it had started (멈추기 on
 * any device, the island's, a call cutting its turn off, a dropped stream: every line it took), or it failed (the
 * lines it had read; the rest go to a follow-up turn). The server sends `steers_dropped` with their ids to every
 * device of the person. The receipt goes wherever a 202 put it, including sends whose result went elsewhere (island
 * 다시 시도, PreDelegateSheet, another device's turn, which a stream's error never reaches). Kept so a 202 still on its
 * way adds none. Ids are the server's, never reused. On the device streaming the turn a stop overlaps ThreadView's own
 * dropStoppedSteers: whichever comes first drops the receipt, the other finds nothing. A failure is this notice alone:
 * only the server knows which lines the turn had read.
 */
const droppedSteers = new Set<ID>();
onServerEvent((e) => {
  if (e.type !== "steers_dropped") return;
  for (const id of e.messageIds) droppedSteers.add(id);
  const s = receipts.get();
  forget(e.messageIds.filter((id) => s[id] === "steered"));
});
/** a `steers_dropped` named this line: its turn stopped or failed and nothing will answer it (the call asks for its notes) */
export const steerDropped = (id: ID) => droppedSteers.has(id);
/**
 * Threads whose error row a `turn_error` put up: a turn the app did not start failed (a briefing, a schedule, a steer
 * follow-up). The server names the dropped lines only for a turn the app started (above), so after these the row order
 * says which lines went unanswered (ThreadView, the call); after a turn of the app's, a line it left queued has a
 * follow-up turn coming and keeps "하던 일에 이어서 전했어요". Gone with the error row (every send clears it).
 */
const remoteFailed = new Set<ID>();
onServerEvent((e) => {
  if (e.type === "turn_error") remoteFailed.add(e.threadId);
});
messagesStore.subscribe(() => {
  if (!remoteFailed.size) return;
  const s = messagesStore.get();
  for (const id of remoteFailed) if (!s[id]?.error) remoteFailed.delete(id);
});
export const failedRemotely = (threadId: ID) => remoteFailed.has(threadId);
/**
 * The follow-up row: is a steered message still waiting for its own answer? `tail` = the last few messages as
 * "id:role" pairs, oldest first. The turn it was steered into answers once (that reply lands after it); a second
 * assistant reply after it means the follow-up has arrived.
 */
export const useAwaitingFollowUp = (tail: string) =>
  useStore(
    receipts,
    (s) => {
      if (!tail) return false;
      const rows = tail.split(",").map((x) => x.split(":") as [string, string]);
      let at = -1;
      rows.forEach(([id], i) => {
        if (s[id] === "steered") at = i;
      });
      if (at < 0) return false;
      return rows.slice(at + 1).filter(([, role]) => role === "assistant").length <= 1;
    },
    Object.is,
  );
