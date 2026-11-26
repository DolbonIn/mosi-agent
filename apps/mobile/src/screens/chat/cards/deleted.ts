import type { Message, Thread } from "@pickle/protocol";

/**
 * What a document or file deleted from the archive (보관함) says in place of its preview, wherever it was shared (H,
 * DD 2103, 2259 §7; the server marks the card `deleted` and sends the message again). Only its owner's side makes
 * documents and attaches files, so the row's author tells who deleted it: the person's own rows (no author, me,
 * my-agent) "보관함에서 지웠어요", the banner's words when they deleted it; a friend's (peer, peer-agent) "{이름} 님이
 * 지웠어요", or the friend would read it as their own doing.
 */
export function deletedNote(author: Message["author"], thread: Thread | undefined): string {
  const k = author?.kind;
  return k === "peer" || k === "peer-agent" ? `${thread?.peer?.displayName ?? "친구"} 님이 지웠어요` : "보관함에서 지웠어요";
}
