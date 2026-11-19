import type { ID } from "@pickle/protocol";

/** what ThreadView last saw at the end of its list: the last row, the live answer's size, and the rows */
export type NewsMark = { lastId: ID | null; draft: string; items: ReadonlyArray<{ id: ID }> };

/**
 * Did something new arrive below since `was` (ThreadView offers "새 메시지" while the person reads above)? A new last
 * row, or a live answer that moved (text, a card, a tool). A row going away is not news: when the server deletes the
 * last row (`message_deleted`, a failed briefing attempt's row on a screen that loaded the thread while it ran), the row
 * now last was there already; an emptied list brings nothing either.
 */
export function arrivedBelow(was: NewsMark, now: NewsMark): boolean {
  if (now.draft !== was.draft) return true;
  if (now.lastId === was.lastId || now.lastId === null) return false;
  return !was.items.some((m) => m.id === now.lastId);
}
