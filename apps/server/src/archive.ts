/** 보관함: artifacts (documents/dashboards made by the agent) and user attachments (files on disk). */
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, Attachment, AttachmentRef } from "@pickle/protocol";
import type { ArtifactRow, AttachmentRow, FriendThreadItem } from "./db/index.ts";
import type { Core } from "./core.ts";
import { areFriends } from "./friends.ts";
import { bad, HttpError, json, notFound, type Ctx } from "./http.ts";
import { newId } from "./util.ts";

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
      if (!db.deleteArtifact(userId, c.params.id!)) throw notFound("문서를 찾을 수 없어요");
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
      db.deleteAttachment(userId, a.id);
      await unlink(attachmentPath(core, userId, a.id)).catch(() => {});
      return json({ ok: true });
    },
  };
}
