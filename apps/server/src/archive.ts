/** 보관함: artifacts (documents/dashboards made by the agent) and user attachments (files on disk). */
import { readFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LlmMessage } from "@pickle/agent";
import type { Artifact, Attachment, AttachmentRef, Card } from "@pickle/protocol";
import type { ArtifactRow, AttachmentRow, FriendThreadItem, MessageRow } from "./db/index.ts";
import { publishMessage, type Core } from "./core.ts";
import { areFriends } from "./friends.ts";
import { bad, HttpError, json, notFound, type Ctx } from "./http.ts";
import { newId, safeJson } from "./util.ts";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** multipart overhead allowance on top of the file itself */
const MULTIPART_SLACK = 64 * 1024;

/** GET /api/blobs/:id of an "html" artifact: no scripts, no network, no framing (the app renders it from the JSON) */
export const HTML_ARTIFACT_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function artifactView(a: ArtifactRow): Artifact {
  return { id: a.id, threadId: a.thread_id, title: a.title, kind: a.kind, content: a.content, createdAt: a.created_at, updatedAt: a.updated_at };
}

export function attachmentRef(a: AttachmentRow): AttachmentRef {
  return { id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: `/api/attachments/${a.id}/raw` };
}

export function attachmentView(a: AttachmentRow): Attachment {
  return { ...attachmentRef(a), threadId: a.thread_id, createdAt: a.created_at };
}

export function allowedMime(mime: string): boolean {
  const m = mime.toLowerCase().split(";")[0]!.trim();
  if (m === "application/pdf" || m === "text/plain") return true;
  // raster images only — SVG can carry script
  return /^image\/(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/.test(m);
}

export function sanitizeFilename(name: string): string {
  const base = String(name ?? "")
    .split(/[\\/]/)
    .pop()!
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "")
    .replace(/^\.+/, "")
    .trim();
  const clipped = base.length > 100 ? base.slice(0, 80) + base.slice(base.lastIndexOf(".")).slice(0, 20) : base;
  return clipped || "file";
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function attachmentPath(core: Core, userId: string, id: string): string {
  return join(core.cfg.dataDir, "attachments", userId, id);
}

/**
 * Someone else's artifact or attachment `viewerId` may read: the owner's side put it in a friend thread both are still
 * members of (the html card under the friend's 모시 answer, a photo the friend sent), and they are still friends. A removed
 * or blocked friend (either way) gets null — the same 404 as anyone else who only knows the id.
 */
function sharedByFriend<T extends { user_id: string }>(core: Core, viewerId: string, row: T | null, item: FriendThreadItem): T | null {
  if (!row || !areFriends(core, viewerId, row.user_id)) return null;
  return core.db.postedInFriendThread(viewerId, row.user_id, item) ? row : null;
}

/** An artifact `userId` may read: their own, or one a friend shared in their friend thread (sharedByFriend). Delete and
 *  the list stay the owner's (deleteArtifact / listArtifacts by user). */
export function readableArtifact(core: Core, userId: string, id: string): ArtifactRow | null {
  return core.db.getArtifact(userId, id) ?? sharedByFriend(core, userId, core.db.artifactById(id), { kind: "artifact", id });
}

/** An attachment `userId` may open: their own, or one a friend sent in their friend thread (sharedByFriend). Delete, the
 *  list and attaching it to a message stay the owner's (getAttachment by user). */
export function readableAttachment(core: Core, userId: string, id: string): AttachmentRow | null {
  return core.db.getAttachment(userId, id) ?? sharedByFriend(core, userId, core.db.attachmentById(id), { kind: "attachment", id });
}

/**
 * Mark what still shows a deleted artifact or attachment (DD 2103), inside the delete's transaction: in every message of
 * a thread the owner is in — their own threads and friend threads alike; only the owner's side ever puts their id in a
 * message, and nobody leaves a thread — the card becomes `{ type, artifactId, title, kind, preview: "", deleted: true }`
 * and the ref `{ id, filename, mime, size, url: "", deleted: true }`. Returns the messages changed, published by the
 * caller after the commit.
 */
function markDeleted(core: Core, ownerId: string, item: FriendThreadItem): string[] {
  const changed: string[] = [];
  for (const row of core.db.messagesMentioning(ownerId, item)) {
    let hit = false;
    if (item.kind === "artifact") {
      const cards = safeJson<Card[]>(row.cards_json, []).map((c): Card => {
        if (c.type !== "artifact" || c.artifactId !== item.id) return c;
        hit = true;
        return { type: "artifact", artifactId: c.artifactId, title: c.title, kind: c.kind, preview: "", deleted: true };
      });
      if (hit) {
        core.db.updateMessageCards(row.id, cards);
        const llm = forgetArtifactCall(llmOf(row), item.id);
        if (llm) core.db.setMessageLlm(row.id, llm);
      }
    } else {
      const was = safeJson<AttachmentRef[]>(row.attachments_json, []);
      let target: AttachmentRef | null = null;
      const refs = was.map((r): AttachmentRef => {
        if (r.id !== item.id) return r;
        hit = true;
        target = r;
        return { id: r.id, filename: r.filename, mime: r.mime, size: r.size, url: "", deleted: true };
      });
      if (hit) {
        core.db.updateMessageAttachments(row.id, refs);
        const llm = forgetAttachmentText(core, ownerId, row, was, refs, target!);
        if (llm) core.db.setMessageLlm(row.id, llm);
      }
    }
    if (hit) changed.push(row.id);
  }
  return changed;
}

// ───────────── the model's copy (llm_json) of what was deleted (H2) ─────────────
// What the model is told in place of a deleted document's result: a fact, no wording to copy into an answer.
const DELETED_ARTIFACT_SUMMARY = "사용자가 보관함에서 이 문서를 지웠어요. 내용은 남아 있지 않아요.";

function llmOf(row: MessageRow): LlmMessage[] | null {
  const parsed = safeJson<unknown>(row.llm_json, null);
  return Array.isArray(parsed) ? (parsed as LlmMessage[]) : null;
}

/**
 * The turn that made a deleted document keeps its tool call and result as a pair (history replay drops a call without
 * its result and a result without its call): the call's arguments lose their `content` key (title and kind stay; never
 * "", which for html means "show the guide"), and the result says it was deleted (`summary`, `deleted: true`). The pair
 * is found by the result's `data.artifactId`; other calls stay as they were. Null when nothing changes.
 */
function forgetArtifactCall(llm: LlmMessage[] | null, artifactId: string): LlmMessage[] | null {
  if (!llm) return null;
  const calls = new Set<string>();
  const next = llm.map((m): LlmMessage => {
    if (m.role !== "tool") return m;
    const r = safeJson<{ data?: { artifactId?: unknown } } | null>(m.content, null);
    if (!r || typeof r !== "object" || r.data?.artifactId !== artifactId) return m;
    calls.add(m.tool_call_id);
    return { ...m, content: JSON.stringify({ ...r, summary: DELETED_ARTIFACT_SUMMARY, deleted: true }) };
  });
  if (!calls.size) return null;
  return next.map((m): LlmMessage => {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || !m.tool_calls.some((c) => calls.has(c.id))) return m;
    return { ...m, tool_calls: m.tool_calls.map((c) => (calls.has(c.id) ? { ...c, function: { ...c.function, arguments: withoutContent(c.function.arguments) } } : c)) };
  });
}

/**
 * A turn's answer row is written once, when the turn ends (turns.ts); a document the turn made and the person deleted
 * while it ran has no row yet for markDeleted to find. Inside that write's transaction, the turn's cards for documents
 * no longer in any archive get H's mark, and its model copy — and a turn paused for approval, its messages — lose them
 * as in forgetArtifactCall. SQLite runs the two transactions one after the other: a delete before this write is caught
 * here, one after it by markDeleted.
 */
export function forgetDeletedInTurn(
  core: Core,
  cards: Card[],
  llm: LlmMessage[] | null,
  prior: LlmMessage[] | null,
): { cards: Card[]; llm: LlmMessage[] | null; prior: LlmMessage[] | null } {
  const out = { cards, llm, prior };
  for (const c of cards) {
    if (c.type !== "artifact" || c.deleted || core.db.artifactById(c.artifactId)) continue;
    out.cards = out.cards.map((x): Card => (x === c ? { type: "artifact", artifactId: c.artifactId, title: c.title, kind: c.kind, preview: "", deleted: true } : x));
    out.llm = forgetArtifactCall(out.llm, c.artifactId) ?? out.llm;
    out.prior = forgetArtifactCall(out.prior, c.artifactId) ?? out.prior;
  }
  return out;
}

function withoutContent(args: string): string {
  const a = safeJson<unknown>(args, null);
  if (!a || typeof a !== "object" || Array.isArray(a)) return "{}"; // unreadable arguments: nothing of them is kept
  const { content: _gone, ...rest } = a as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** Small text files go to the model inline, up to this size (threads.ts llmUserContent). */
export const TEXT_ATTACHMENT_INLINE = 8 * 1024;

/** A deleted file in the model's copy of the message that sent it. */
export const deletedFileNote = (a: Pick<AttachmentRef, "filename">) => `[첨부: ${a.filename} — 보관함에서 지운 파일이라 내용이 없어요]`;

/**
 * What the model gets for a message's files, after the text (threads.ts llmUserContent): small text files inline, a
 * short note for the rest, and for a deleted file only that it was deleted. Synchronous (≤ 10 files of ≤ 8 KB) so a
 * delete can rebuild it inside its transaction.
 */
export function attachmentNotes(core: Core, userId: string, atts: AttachmentRef[]): string {
  const notes: string[] = [];
  for (const a of atts) {
    if (a.deleted) {
      notes.push(deletedFileNote(a));
      continue;
    }
    if (a.mime === "text/plain" && a.size <= TEXT_ATTACHMENT_INLINE) {
      try {
        notes.push(`[첨부: ${a.filename}]\n${fileText(readFileSync(attachmentPath(core, userId, a.id)))}`);
        continue;
      } catch {
        /* fall through */
      }
    }
    notes.push(`[첨부: ${a.filename} (${a.mime}, ${Math.ceil(a.size / 1024)}KB) — 내용은 볼 수 없어요]`);
  }
  return notes.join("\n");
}

/**
 * A text file's bytes read the way Bun.file().text() reads them, which made every note before H2 (an old row's notes
 * must come out the same to the byte to be found again): after a UTF-16LE BOM with more behind it, UTF-16LE code
 * units as they are (an odd last byte dropped, a lone surrogate kept); anything else UTF-8, its BOM dropped and bad
 * bytes as U+FFFD.
 */
export function fileText(b: Uint8Array): string {
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xfe) {
    let s = "";
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i]! | (b[i + 1]! << 8));
    return s;
  }
  return new TextDecoder().decode(b);
}

/**
 * The model's copy of a message that sent a now deleted file: its user content is rebuilt with the files' notes made
 * again (attachmentNotes, the deleted one as deleted), keeping the text before them and anything after them (a template
 * hint) as it was. If that copy was not made the usual way, only the deleted file's inlined text is replaced, wherever
 * it appears. Null when nothing changes (an image or PDF was never inlined, but its note still becomes the deleted one).
 */
function forgetAttachmentText(core: Core, ownerId: string, row: MessageRow, was: AttachmentRef[], now: AttachmentRef[], target: AttachmentRef): LlmMessage[] | null {
  const llm = llmOf(row);
  if (!llm) return null;
  const head = `${row.text}\n\n${attachmentNotes(core, ownerId, was)}`;
  const made = `${row.text}\n\n${attachmentNotes(core, ownerId, now)}`;
  let inlined: string | null | undefined;
  let changed = false;
  const next = llm.map((m): LlmMessage => {
    if (m.role !== "user" || typeof m.content !== "string") return m;
    let c = m.content;
    if (c.startsWith(head)) c = made + c.slice(head.length);
    else {
      inlined ??= attachmentNotes(core, ownerId, [target]);
      if (inlined.startsWith(`[첨부: ${target.filename}]\n`) && c.includes(inlined)) c = c.split(inlined).join(deletedFileNote(target));
    }
    if (c === m.content) return m;
    changed = true;
    return { ...m, content: c };
  });
  // a small text file whose text was in neither form: left as it was, said once (no names in logs)
  if (!changed && target.mime === "text/plain" && target.size <= TEXT_ATTACHMENT_INLINE && llm.some((m) => m.role === "user"))
    core.log.info("deleted file: its text not found in the model copy", { message: row.id });
  return changed ? next : null;
}

export function archiveRoutes(core: Core) {
  const { db } = core;
  return {
    listArtifacts: (_c: Ctx, userId: string) => json(db.listArtifacts(userId).map(artifactView)),
    getArtifact: (c: Ctx, userId: string) => {
      const a = readableArtifact(core, userId, c.params.id!);
      if (!a) throw notFound("문서를 찾을 수 없어요");
      return json(artifactView(a));
    },
    deleteArtifact: (c: Ctx, userId: string) => {
      const id = c.params.id!;
      const marked = db.tx(() => (db.deleteArtifact(userId, id) ? markDeleted(core, userId, { kind: "artifact", id }) : null));
      if (!marked) throw notFound("문서를 찾을 수 없어요");
      for (const m of marked) publishMessage(core, m); // every device of every member of those threads
      return json({ ok: true });
    },
    blob: (c: Ctx, userId: string) => {
      const a = readableArtifact(core, userId, c.params.id!);
      if (!a) throw notFound("문서를 찾을 수 없어요");
      if (a.kind === "html") {
        // the cleaned fragment as a download; opened anyway, it is a sandboxed page that loads nothing and runs nothing
        return new Response(a.content, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Disposition": contentDisposition(`${a.title}.html`).replace(/^inline/, "attachment"),
            "Content-Security-Policy": HTML_ARTIFACT_CSP,
            "Cache-Control": "private, no-store",
          },
        });
      }
      const type = a.kind === "dashboard" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8";
      return new Response(a.content, {
        headers: { "Content-Type": type, "Content-Disposition": contentDisposition(`${a.title}.${a.kind === "dashboard" ? "json" : "md"}`), "Cache-Control": "private, no-store" },
      });
    },

    upload: async (c: Ctx, userId: string) => {
      const ct = c.req.headers.get("content-type") ?? "";
      if (!ct.toLowerCase().startsWith("multipart/form-data")) throw bad("multipart/form-data로 파일을 보내 주세요", "invalid_upload");
      const len = Number(c.req.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(len) && len > MAX_ATTACHMENT_BYTES + MULTIPART_SLACK) throw new HttpError(413, "file_too_large", "파일은 10MB까지 올릴 수 있어요");
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw bad("파일을 읽지 못했어요", "invalid_upload");
      }
      const file = form.get("file");
      if (!file || typeof file === "string") throw bad("file 필드에 파일을 넣어 주세요", "invalid_upload");
      if (file.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "file_too_large", "파일은 10MB까지 올릴 수 있어요");
      if (file.size === 0) throw bad("빈 파일이에요", "invalid_upload");
      const mime = (file.type || "application/octet-stream").toLowerCase().split(";")[0]!.trim();
      if (!allowedMime(mime)) throw new HttpError(415, "unsupported_type", "이미지, PDF, 텍스트 파일만 올릴 수 있어요");
      let threadId: string | null = null;
      const t = form.get("threadId");
      if (typeof t === "string" && t) {
        if (!db.threadFor(t, userId)) throw notFound("대화를 찾을 수 없어요");
        threadId = t;
      }
      const id = newId("f");
      await mkdir(join(core.cfg.dataDir, "attachments", userId), { recursive: true });
      await Bun.write(attachmentPath(core, userId, id), file);
      db.insertAttachment({ id, userId, threadId, filename: sanitizeFilename(file.name), mime, size: file.size, now: core.now() });
      return json(attachmentView(db.getAttachment(userId, id)!), 201);
    },
    listAttachments: (_c: Ctx, userId: string) => json(db.listAttachments(userId).map(attachmentView)),
    raw: async (c: Ctx, userId: string) => {
      const a = readableAttachment(core, userId, c.params.id!);
      if (!a) throw notFound("파일을 찾을 수 없어요");
      // the file lives under its owner (a friend's photo is in their folder)
      const f = Bun.file(attachmentPath(core, a.user_id, a.id));
      if (!(await f.exists())) throw notFound("파일을 찾을 수 없어요");
      const type = a.mime === "text/plain" ? "text/plain; charset=utf-8" : a.mime;
      return new Response(f, {
        headers: {
          "Content-Type": type,
          "Content-Length": String(f.size),
          "Content-Disposition": contentDisposition(a.filename),
          // a friend's file is asked for again on every load, so a block or removal takes effect at once
          "Cache-Control": a.user_id === userId ? "private, max-age=3600" : "private, no-cache",
          // user content: never scriptable (PDF viewers refuse to run inside a CSP sandbox)
          "Content-Security-Policy":
            a.mime === "application/pdf"
              ? "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'"
              : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        },
      });
    },
    deleteAttachment: async (c: Ctx, userId: string) => {
      const a = db.getAttachment(userId, c.params.id!);
      if (!a) throw notFound("파일을 찾을 수 없어요");
      const marked = db.tx(() => (db.deleteAttachment(userId, a.id) ? markDeleted(core, userId, { kind: "attachment", id: a.id }) : null));
      if (!marked) throw notFound("파일을 찾을 수 없어요"); // another delete got there first
      for (const m of marked) publishMessage(core, m);
      await unlink(attachmentPath(core, userId, a.id)).catch(() => {});
      return json({ ok: true });
    },
  };
}
