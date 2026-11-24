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
/** the receipts map itself (ThreadView's error row goes above the lines still marked; the follow-up row) */
export const useReceipts = () => useStore(receipts, (s) => s, Object.is);

/**
 * The steered lines a stopped turn left unanswered (a turn sent from this device came back stopped: dropStoppedSteers;
 * a failure is the server's `steers_dropped` alone, below). `rows` = the thread's messages as [id, role], oldest first.
 *  - lines after the last reply: the stopped turn is the one they went into
 *  - none there, and no line of the person's after that reply either: the reply is the stopped turn's partial answer
 *    (the server dates it at the end, after the lines it streamed past). Then the steered lines just before it, back
 *    to the line that started that turn (one with no steer receipt), an event row or an earlier reply
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
 * A send that came back stopped after its turn had started (멈추기, or the island's): the server answers none of the
 * lines steered into that turn (no follow-up turn after a Stop), so they lose their receipt, as after a failure.
 */
export function dropStoppedSteers(r: Pick<SendResult, "status" | "accepted">, items: readonly Row[]) {
  if (r.status === "aborted" && r.accepted) dropUnansweredSteers(rowsOf(items));
}

/** a stopped turn's unanswered steered lines lose "하던 일에 이어서 전했어요" for good: it would read as handled */
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
 * Lines steered into a turn that will never answer them: a turn the app started stopped after it had started (멈추기
 * on any device, the island's, a call cutting its turn off, a dropped stream: every line it took), or any turn failed,
 * the app's, a briefing, a schedule or a follow-up (the lines it had read, and a follow-up's own lines; the rest stay
 * queued for the next follow-up turn and keep their receipt). The server sends `steers_dropped` with their ids to every
 * device of the person, after its `turn_error` when the turn failed. The receipt goes wherever a 202 or a live push put
 * it, including sends whose result went elsewhere (island 다시 시도, PreDelegateSheet, another device's turn, which a
 * stream's error never reaches). Kept so a 202 still on its way adds none. Ids are the server's, never reused. On the
 * device streaming the turn a stop overlaps ThreadView's own dropStoppedSteers: whichever comes first drops the
 * receipt, the other finds nothing. A failure is this notice alone: only the server knows which lines the turn had read.
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
 * A live `message` push of the person's line with the receipt its sending device got from the request's answer: the
 * line gets it on this device too, so every open device of the person draws the same rows.
 *  - `steered: true`, a line the server steered into a running turn (the 202): "하던 일에 이어서 전했어요" (the error row
 *    goes above the lines handed to a follow-up turn, 이어서 하는 중)
 *  - `delivered: true`, their friend-thread line that reached the friend without a turn (the 201): "전달됨" (only on
 *    their own line; the server sends it to the author's devices alone)
 * Only for a line that was not here before this push (a page read never carries the fields; a push of a row already
 * here brings no dropped receipt back) and never for one a `steers_dropped` named (markReceipt). events.ts has put the
 * row in before listeners run: `shownBefore` is the threads as they were just before that.
 */
let shown = messagesStore.get();
let shownBefore = shown;
messagesStore.subscribe(() => {
  shownBefore = shown;
  shown = messagesStore.get();
});
onServerEvent((e) => {
  if (e.type !== "message" || e.message.role !== "user") return;
  const m = e.message;
  const kind: Receipt | null = m.steered ? "steered" : m.delivered && m.author?.kind === "me" ? "delivered" : null;
  if (!kind || shownBefore[e.threadId]?.items.some((x) => x.id === m.id)) return;
  markReceipt(m.id, kind);
});
/**
 * Where each thread's error row sits: right after the row that was the thread's last when the error came (the failed
 * turn's rows end there). What comes later (a follow-up turn's answer to a line the failed turn left, a line from
 * another device) goes below it, so the row stays with the turn that failed. A line still being sent then was sent
 * before the failure (its 202 lands late): the row goes after it, at the server's row once that replaces it, or after
 * the row before it if the send goes away. A later failure while the row is up (a `turn_error`: the follow-up failed
 * too, or the day's quota kept it from running) moves it to that turn's end. A thread with no rows here yet gets its
 * place once they arrive; a row that is gone (deleted): the error row goes last. Gone with the row.
 */
const errorAnchor = new Map<ID, ID | null>();
const lastOf = <T,>(xs: readonly T[], ok: (x: T) => boolean): T | undefined => {
  for (let i = xs.length - 1; i >= 0; i--) if (ok(xs[i]!)) return xs[i];
  return undefined;
};
function anchorError(threadId: ID) {
  const t = messagesStore.get()[threadId];
  if (!t?.error || (!t.loaded && !t.items.length)) return;
  errorAnchor.set(threadId, t.items.at(-1)?.id ?? null);
}
let seenThreads = messagesStore.get();
messagesStore.subscribe(() => {
  const s = messagesStore.get();
  const prev = seenThreads;
  seenThreads = s;
  for (const [id, at] of errorAnchor) {
    const t = s[id];
    if (!t?.error) errorAnchor.delete(id);
    else if (at && isTempId(at) && t !== prev[id] && !t.items.some((m) => m.id === at)) {
      // the line being sent when the error came is no longer an optimistic row: the server's copy of it that came in
      // its place, or (refused, stopped) the row before it
      const had = prev[id]?.items ?? [];
      const known = new Set(had.map((m) => m.id));
      const copy = lastOf(t.items, (m) => m.role === "user" && !isTempId(m.id) && !known.has(m.id));
      const before = lastOf(had.slice(0, Math.max(0, had.findIndex((m) => m.id === at))), (m) => !isTempId(m.id));
      errorAnchor.set(id, copy?.id ?? before?.id ?? null);
    }
  }
  for (const id in s) if (s[id] !== prev[id] && !errorAnchor.has(id)) anchorError(id);
});
onServerEvent((e) => {
  if (e.type === "turn_error") anchorError(e.threadId); // events.ts set the error first; listeners run after
});
/** the row this thread's error row follows (undefined: no error row, or its rows are not loaded yet) */
export const errorAnchorOf = (threadId: ID): ID | null | undefined => errorAnchor.get(threadId);
/**
 * Where the error row goes among `items`: the index of the row it follows. That is its anchor, moved up past the
 * person's lines still marked "하던 일에 이어서 전했어요" (`steered`): the failed turn never read them, a follow-up turn
 * answers them, so they go below it with their receipts. A line the failed turn read (its receipt dropped), the line that
 * started it and a partial answer stay above. -1: above the first row (every row up to it handed over); null: the anchor
 * is not among the rows (none yet, deleted), the error row goes last.
 */
export function errorRowAfter(items: readonly Row[], anchor: ID | null | undefined, steered: (id: ID) => boolean): number | null {
  let i = anchor ? items.findIndex((m) => m.id === anchor) : -1;
  if (i < 0) return null;
  while (i >= 0 && items[i]!.role === "user" && steered(items[i]!.id)) i--;
  return i;
}
/**
 * The follow-up row: is a steered message still waiting for its own answer? `tail` = the last few messages as
 * "id:role" pairs, oldest first. The turn it was steered into answers once (that reply lands after it); a second
 * assistant reply after it means the follow-up has arrived.
 * Worked out in render from the whole receipts map: useStore keeps a selection until the store changes, so a selector
 * reading `tail` would keep the answer for the tail before. A pushed line's receipt (above) is marked right after
 * events.ts put the line in, before the thread re-renders with the new tail: the selection then made with the old tail
 * stayed, and that device never showed 이어서 하는 중.
 */
export function useAwaitingFollowUp(tail: string): boolean {
  const s = useReceipts();
  if (!tail) return false;
  const rows = tail.split(",").map((x) => x.split(":") as [string, string]);
  let at = -1;
  rows.forEach(([id], i) => {
    if (s[id] === "steered") at = i;
  });
  if (at < 0) return false;
  return rows.slice(at + 1).filter(([, role]) => role === "assistant").length <= 1;
}
