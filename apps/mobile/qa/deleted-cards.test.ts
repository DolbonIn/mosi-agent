// A document or file deleted from the archive (보관함) stays in the conversation as a marked card (H, DD 2103, 2259 §7;
// the server sends `deleted: true` on the card / ref, preview and url emptied): the one-row card with the glyph, the
// title or filename in secondary colour and who deleted it, nothing to tap; an html card loses its page frame. Who
// deleted it comes from the row's author (cards/deleted.ts).
//   bun test ./qa/deleted-cards.test.ts
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactCard as ArtifactRef, AttachmentRef, Message, Thread } from "@pickle/protocol";
import { ArtifactCard } from "../src/screens/chat/cards/ArtifactCard";
import { CardView } from "../src/screens/chat/cards/CardView";
import { HtmlArtifactCard } from "../src/artifact/HtmlArtifactCard";
import { deletedNote } from "../src/screens/chat/cards/deleted";
import { Attachments, MessageRow, type RowContext } from "../src/screens/chat/Messages";
import { Icon } from "../src/ui/Icon";

const html = (el: Parameters<typeof createElement>[0], props: object) => renderToStaticMarkup(createElement(el as never, props as never));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/ /g, " ");
const friendThread = { id: "t_f", kind: "friend", title: "서연", peer: { userId: "u_s", displayName: "서연", agentName: "콩이" } } as unknown as Thread;
const doc: ArtifactRef = { type: "artifact", artifactId: "a_doc", title: "강남역 저녁 후보", kind: "document", preview: "", deleted: true };
const page: ArtifactRef = { type: "artifact", artifactId: "a_html", title: "저녁 후보 세 곳", kind: "html", preview: "", deleted: true };
const photo: AttachmentRef = { id: "f_1", filename: "영수증.png", mime: "image/png", size: 12, url: "", deleted: true };
const pdf: AttachmentRef = { id: "f_2", filename: "계약서.pdf", mime: "application/pdf", size: 12, url: "", deleted: true };
const icon = (name: "photo" | "doc", size: number) => renderToStaticMarkup(createElement(Icon, { name, size }));

describe("who deleted it (the row's author)", () => {
  test("the person's own rows: no author (their own threads), me, my-agent → 보관함에서 지웠어요", () => {
    expect(deletedNote(undefined, undefined)).toBe("보관함에서 지웠어요");
    expect(deletedNote({ kind: "me", name: "하늘" }, friendThread)).toBe("보관함에서 지웠어요");
    expect(deletedNote({ kind: "my-agent", name: "모시" }, friendThread)).toBe("보관함에서 지웠어요");
  });
  test("a friend's rows (peer, peer-agent) → {thread.peer.displayName} 님이 지웠어요; no peer known → 친구 님", () => {
    expect(deletedNote({ kind: "peer", name: "서연 님" }, friendThread)).toBe("서연 님이 지웠어요");
    expect(deletedNote({ kind: "peer-agent", name: "서연 님의 콩이" }, friendThread)).toBe("서연 님이 지웠어요");
    expect(deletedNote({ kind: "peer", name: "서연 님" }, undefined)).toBe("친구 님이 지웠어요");
  });
});

describe("a deleted document card", () => {
  test("the glyph, the title and the note; no button, no chevron, no preview line", () => {
    const m = html(ArtifactCard, { card: doc });
    expect(m).toContain('class="ccard ccard-artifact is-deleted"');
    expect(m).not.toContain("<button");
    expect(m).not.toContain("art-chev");
    expect(m).not.toContain("tabindex");
    expect(text(m)).toBe("강남역 저녁 후보보관함에서 지웠어요");
    expect(text(html(ArtifactCard, { card: doc, note: "서연 님이 지웠어요" }))).toBe("강남역 저녁 후보서연 님이 지웠어요");
  });
  test("not deleted: the button that opens it, as before", () => {
    const m = html(ArtifactCard, { card: { ...doc, deleted: undefined, preview: "1. 하나" } });
    expect(m).toContain("<button");
    expect(m).toContain("art-chev");
    expect(text(m)).toBe("강남역 저녁 후보문서 · 1. 하나");
  });
  test("an html card, deleted: the one-row card (no page frame); not deleted: the page card", () => {
    const base = { index: 0, messageId: "m_1", threadId: "t_main", tools: [], onSend: () => {} };
    const gone = html(CardView, { ...base, card: page, deletedNote: "서연 님이 지웠어요" });
    expect(gone).toContain("is-deleted");
    expect(gone).not.toContain("hart");
    expect(text(gone)).toBe("저녁 후보 세 곳서연 님이 지웠어요");
    // the page card needs a window to draw: which component CardView picks (its memo's render, one level deep)
    const pick = (card: ArtifactRef) => (CardView as unknown as { type: (p: object) => { type: unknown } }).type({ ...base, card }).type;
    expect(pick({ ...page, deleted: undefined, preview: "세 곳" })).toBe(HtmlArtifactCard);
    expect(pick(page)).toBe(ArtifactCard);
  });
});

describe("a deleted file", () => {
  test("a picture: the one-row card in its place (photo glyph, filename, note), no link, no image", () => {
    const m = html(Attachments, { items: [photo] });
    expect(m).not.toContain("<a ");
    expect(m).not.toContain("<img");
    expect(m).toContain('class="bubble-file is-deleted"');
    expect(m).toContain(icon("photo", 18));
    expect(text(m)).toBe("영수증.png보관함에서 지웠어요");
  });
  test("another file: the doc glyph; the other files of the message stay as they were", () => {
    const kept: AttachmentRef = { id: "f_3", filename: "사진.jpg", mime: "image/jpeg", size: 12, url: "/api/attachments/f_3/raw" };
    const m = html(Attachments, { items: [pdf, kept], note: "서연 님이 지웠어요" });
    expect(m).toContain(icon("doc", 18));
    expect(m).not.toContain(icon("photo", 18));
    expect(text(m)).toContain("계약서.pdf서연 님이 지웠어요");
    expect(m.match(/<a /g)?.length).toBe(1);
    expect(m).toContain('alt="사진.jpg"');
  });
});

describe("in its row", () => {
  const ctx = (thread: Thread | undefined): RowContext => ({ threadId: thread?.id ?? "t_main", thread, agentName: "모시", agentSpec: { hue: 200, shape: "round", eyes: "dot" } as RowContext["agentSpec"], onSend: () => {}, onRetry: () => {} });
  const row = (m: Partial<Message>, thread: Thread | undefined) =>
    text(html(MessageRow, { m: { id: "m_1", threadId: thread?.id ?? "t_main", role: "user", text: "", cards: [], tools: [], attachments: [], createdAt: 1, ...m }, ctx: ctx(thread), failed: false, fresh: false }));
  test("a friend's line in a friend thread: their name; my own line there: 보관함에서", () => {
    expect(row({ attachments: [photo], author: { kind: "peer", name: "서연 님" } }, friendThread)).toContain("영수증.png서연 님이 지웠어요");
    expect(row({ attachments: [photo], author: { kind: "me", name: "하늘" } }, friendThread)).toContain("영수증.png보관함에서 지웠어요");
  });
  test("the friend's 모시's answer (peer-agent) with a deleted page card: their name; my main thread: 보관함에서", () => {
    expect(row({ role: "assistant", text: "골랐어요", cards: [page], author: { kind: "peer-agent", name: "서연 님의 콩이" } }, friendThread)).toContain("저녁 후보 세 곳서연 님이 지웠어요");
    expect(row({ role: "assistant", text: "골랐어요", cards: [doc] }, undefined)).toContain("강남역 저녁 후보보관함에서 지웠어요");
  });
});
