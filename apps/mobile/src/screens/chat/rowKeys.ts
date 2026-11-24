import type { ID, Message } from "@pickle/protocol";
import { isTempId } from "../../api/store";

/**
 * A thread's row keys, so the optimistic copy of a line and the server's row that takes its place are one element (DD
 * 1957 1). The store swaps the copy (a temp id) for the stored row in one change, whichever comes first: the server's
 * push of the line, the turn's start, the 202 / 201. Keyed by id, the row would mount again and its entrance start
 * over: Chrome drew the server's row at opacity 0.01–0.02 the frame after the swap (DD 1957 also saw the gap above snap
 * 18 → 12 px, and WebKit replay the entrance when the 202 came late). A row new since the last call whose user text
 * matches a copy that went away keeps that copy's key (two copies of the same text pair up in order); every other row
 * is keyed by its id. Ids are never reused, so keys stay unique. Call once per render with the thread's items; `fresh`
 * is decided once per key, when its row is first drawn (the server row is dated by the server, the copy by this
 * device).
 */
export function rowKeys() {
  let prev: readonly Message[] = [];
  const alias = new Map<ID, ID>(); // server id → the key its copy was drawn under
  const fresh = new Map<ID, boolean>();
  return (items: readonly Message[]) => {
    if (items !== prev) {
      const ids = new Set(items.map((m) => m.id));
      const gone = prev.filter((m) => isTempId(m.id) && m.role === "user" && !ids.has(m.id));
      if (gone.length) {
        const had = new Set(prev.map((m) => m.id));
        for (const m of items) {
          if (had.has(m.id) || isTempId(m.id) || m.role !== "user" || alias.has(m.id)) continue;
          const i = gone.findIndex((c) => c.text === m.text);
          if (i < 0) continue;
          alias.set(m.id, alias.get(gone[i].id) ?? gone[i].id);
          gone.splice(i, 1);
        }
      }
      prev = items;
    }
    const keyOf = (m: Message) => alias.get(m.id) ?? m.id;
    return {
      keyOf,
      /** whether the row enters with the list's entrance; the first answer for its key stands */
      freshOf(m: Message, isFresh: () => boolean) {
        const k = keyOf(m);
        let f = fresh.get(k);
        if (f === undefined) fresh.set(k, (f = isFresh()));
        return f;
      },
    };
  };
}
