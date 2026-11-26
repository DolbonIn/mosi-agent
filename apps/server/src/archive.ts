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
  // text: plain and Markdown only (no HTML or any other text/*)
  if (m === "application/pdf" || m === "text/plain" || m === "text/markdown" || m === "text/x-markdown") return true;
  // raster images only — SVG can carry script
  return /^image\/(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/.test(m);
}

/**
 * The type an upload is stored as, or null when it is not taken. A file that came without a type, or as
 * application/octet-stream (iOS can send either), is told by its name: .txt is text/plain, .md and .markdown are
 * text/markdown. Markdown is always stored as text/markdown. (Bun's multipart parser types a file part by its name's
 * extension and leaves out the part's own Content-Type: a name without a known extension comes as "".)
 */
export function storedMime(type: string, filename: string): string | null {
  let m = type.toLowerCase().split(";")[0]!.trim();
  if (!m || m === "application/octet-stream") {
    const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
    m = ext === "txt" ? "text/plain" : ext === "md" || ext === "markdown" ? "text/markdown" : "";
  }
  if (m === "text/x-markdown") m = "text/markdown";
  return m && allowedMime(m) ? m : null;
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

/** Text files the model reads (threads.ts llmUserContent): plain text and Markdown. */
export const READ_TEXT_MIMES: ReadonlySet<string> = new Set(["text/plain", "text/markdown"]);
/**
 * The most of one text file the model gets in a message, and of all the message's text files together, in characters
 * (UTF-16 code units; tokens follow characters, not bytes). A Korean character is ~0.7–1.2 tokens and an English one
 * ~0.25 (estimates), so a full Korean file is ~21k–36k tokens on each model call of its turn and of the next turn,
 * whose history still holds the request (trimHistory keeps the last one; after that its 24 KB window drops the file):
 * a file and one follow-up turn come to ~12–22% of the day's 400k billable tokens (agent-runtime 1755).
 */
export const TEXT_FILE_MAX_CHARS = 30_000;
export const TEXT_MESSAGE_MAX_CHARS = 50_000;
/** a file cut at its cap ends at its last line break when there is one this close to the cap */
const CUT_AT_LINE_WITHIN = 2_000;
/** before 11-26, only text/plain files of up to this size went inline, whole */
const V1_INLINE_BYTES = 8 * 1024;

/** How a message's file notes are made: as now, or as before 11-26 ("v1"; an old row is made again by its own rule). */
type NoteRule = "now" | "v1";

/** A deleted file in the model's copy of the message that sent it. */
export const deletedFileNote = (a: Pick<AttachmentRef, "filename">) => `[첨부: ${a.filename} — 보관함에서 지운 파일이라 내용이 없어요]`;

const count = (n: number) => n.toLocaleString("ko-KR");
/**
 * The person sees only the file's name, so a file the model did not read to the end is told to them in the answer, once
 * (DD 1743; described, never a sample line the model would copy).
 */
const TELL_ONCE = "이 파일을 두고 처음 답할 때 한 번, ";

/**
 * What the model gets for a person's line that came with files (threads.ts llmUserContent): the text, a blank line, then
 * each file's note (fileNotes), one per line. A line with no text whose files the model reads (a text file, whole or
 * cut) begins with FILES_ONLY_NOTE in place of the text, so the file's text reads as what the person sent (a long
 * message the app turned into a file arrives so); one with only images or PDFs begins with nothing. `rule` "v1" makes
 * the notes as before 11-26 (no line was sent without text then).
 */
export function withFiles(core: Core, userId: string, text: string, atts: AttachmentRef[], rule: NoteRule = "now"): string {
  return linesOf(text, fileNotes(core, userId, atts, rule), rule);
}

/**
 * What stands for a line sent with files and no text where a line is shown (a friend thread's list row, a friend's
 * banner; DD 1811): "사진" / "사진 N장" when every file is an image, else the first other file's name, with " 외 N개" for
 * the rest. The stored row keeps its empty text.
 */
export function filesLine(atts: Pick<AttachmentRef, "filename" | "mime">[]): string {
  const other = atts.find((a) => !a.mime.startsWith("image/"));
  if (!other) return atts.length > 1 ? `사진 ${atts.length}장` : "사진";
  return atts.length > 1 ? `${other.filename} 외 ${atts.length - 1}개` : other.filename;
}

/**
 * The title of the person's new thread whose first line is files with no text (DD 1811): the first file that is not
 * an image, its name without the extension (40 characters at most, as an automatic title). Null when every file is an
 * image (the automatic title then comes as before).
 */
export function filesTitle(atts: Pick<AttachmentRef, "filename" | "mime">[]): string | null {
  const name = atts.find((a) => !a.mime.startsWith("image/"))?.filename;
  if (!name) return null;
  const bare = name.replace(/\.[^.\s]{1,10}$/, "").trim() || name;
  return Array.from(bare).slice(0, 40).join("");
}

/** Described, with no sample answer (DD 1736 §5). */
export const FILES_ONLY_NOTE =
  "[이 사람이 글 없이 파일만 보냈어요. 아래 파일의 글을 이 사람이 보낸 메시지로 읽고 답해 주세요. 글에 부탁이 있으면 그대로 해 주세요. 파일을 받았다는 말로만 끝내지 마세요]";

const linesOf = (text: string, notes: FileNote[], rule: NoteRule) =>
  `${text || (rule === "now" && notes.some((n) => n.read) ? FILES_ONLY_NOTE : "")}\n\n${notes.map((n) => n.note).join("\n")}`;

/** A file's note in the model's copy, and whether it holds any of the file's text. */
type FileNote = { note: string; read: boolean };

/**
 * Each file's note, in order. A deleted file: only that it was deleted. A text file (plain or Markdown): its text,
 * up to TEXT_FILE_MAX_CHARS, and TEXT_MESSAGE_MAX_CHARS for all of them together in order. A file cut there says how
 * much of it the model has, above the text and again where it stops, so the model never answers as if it had read the
 * rest; one that finds nothing left says it was not read. Both ask the model to tell the person so, once. Anything else: a short note. `rule` "v1": as before 11-26
 * (text/plain of up to 8 KB inline whole, a short note for the rest). Synchronous (≤ 10 files, each read once) so a
 * delete can make them again inside its transaction.
 */
function fileNotes(core: Core, userId: string, atts: AttachmentRef[], rule: NoteRule): FileNote[] {
  const out: FileNote[] = [];
  const push = (note: string, read = false) => out.push({ note, read });
  let left = TEXT_MESSAGE_MAX_CHARS;
  for (const a of atts) {
    if (a.deleted) {
      push(deletedFileNote(a));
      continue;
    }
    const other = `[첨부: ${a.filename} (${a.mime}, ${Math.ceil(a.size / 1024)}KB) — 내용은 볼 수 없어요]`;
    const v1 = rule === "v1";
    if (v1 ? a.mime !== "text/plain" || a.size > V1_INLINE_BYTES : !READ_TEXT_MIMES.has(a.mime)) {
      push(other);
      continue;
    }
    const cap = v1 ? Infinity : Math.min(TEXT_FILE_MAX_CHARS, left);
    let file: { text: string; chars: number };
    try {
      file = readText(attachmentPath(core, userId, a.id), cap + 1);
    } catch {
      push(other);
      continue;
    }
    if (file.chars <= cap) {
      push(`[첨부: ${a.filename}]\n${file.text}`, true);
      left -= file.chars;
      continue;
    }
    const head = cutText(file.text, cap);
    if (!head) {
      push(`[첨부: ${a.filename} (${count(file.chars)}자) — 이 메시지에 실을 수 있는 글자 수를 넘어서 읽지 못했어요. ${TELL_ONCE}읽지 못했다는 것을 사람에게 알려 주세요]`);
      continue;
    }
    left -= head.length;
    push(
      `[첨부: ${a.filename} — 전체 ${count(file.chars)}자 중 앞 ${count(head.length)}자만 읽었어요. 뒤 ${count(file.chars - head.length)}자는 이 대화에 없어요. ` +
        `${TELL_ONCE}앞부분만 읽었다는 것과 읽은 양을 사람에게 알려 주세요]\n` +
        `${head}\n[첨부: ${a.filename} — 여기서 잘렸어요]`,
      true,
    );
  }
  return out;
}

/**
 * A text file's text (fileText) and its length in characters. A UTF-16 file longer than `need` characters is made
 * text only that far (its length comes from its size); a UTF-8 one is decoded whole (≤ 10 MB).
 */
function readText(path: string, need: number): { text: string; chars: number } {
  const b = readFileSync(path);
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xfe) {
    const chars = Math.floor((b.length - 2) / 2);
    return { text: fileText(chars > need ? b.subarray(0, 2 + need * 2) : b), chars };
  }
  const text = fileText(b);
  return { text, chars: text.length };
}

/**
 * The first `cap` characters of a text: up to its last line break when one is within CUT_AT_LINE_WITHIN of the cap
 * (a line's "\r" too), else at the cap, never between the two halves of a surrogate pair.
 */
function cutText(text: string, cap: number): string {
  const s = text.slice(0, cap);
  const nl = s.lastIndexOf("\n");
  if (nl > 0 && nl >= cap - CUT_AT_LINE_WITHIN) return s.slice(0, s[nl - 1] === "\r" ? nl - 1 : nl);
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
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
 * again (fileNotes, the deleted one as deleted), keeping the text before them and anything after them (a template
 * hint) as it was. The notes are looked for as made now, then as made before 11-26, and made again by the rule that
 * matched, so an old row gets no text it never had (a text file over 8 KB keeps its short note). If that copy was not
 * made the usual way, only the deleted file's text (as either rule put it in) is replaced, wherever it appears. Null
 * when nothing changes (an image or PDF was never inlined, but its note still becomes the deleted one).
 */
function forgetAttachmentText(core: Core, ownerId: string, row: MessageRow, was: AttachmentRef[], now: AttachmentRef[], target: AttachmentRef): LlmMessage[] | null {
  const llm = llmOf(row);
  if (!llm) return null;
  const made = new Map<NoteRule, { head: string; notes: string[] }>();
  const form = (rule: NoteRule) => {
    let f = made.get(rule);
    if (!f) {
      const notes = fileNotes(core, ownerId, was, rule);
      made.set(rule, (f = { notes: notes.map((n) => n.note), head: linesOf(row.text, notes, rule) }));
    }
    return f;
  };
  // the file's text as each rule put it in: in the message (the message cap may have cut it) or alone
  let texts: string[] | undefined;
  const textsOf = () =>
    (texts ??= [...new Set([form("now").notes[was.indexOf(target)], fileNotes(core, ownerId, [target], "now")[0]?.note, form("v1").notes[was.indexOf(target)]])].filter(
      (x): x is string => !!x && (x.startsWith(`[첨부: ${target.filename}]\n`) || x.startsWith(`[첨부: ${target.filename} — 전체 `)),
    ));
  let changed = false;
  const next = llm.map((m): LlmMessage => {
    if (m.role !== "user" || typeof m.content !== "string") return m;
    let c = m.content;
    const rule = (["now", "v1"] as const).find((r) => c.startsWith(form(r).head));
    if (rule) c = withFiles(core, ownerId, row.text, now, rule) + c.slice(form(rule).head.length);
    else for (const t of textsOf()) if (c.includes(t)) c = c.split(t).join(deletedFileNote(target));
    if (c === m.content) return m;
    changed = true;
    return { ...m, content: c };
  });
  // a text file whose text was in neither form: left as it was, said once (no names in logs)
  if (!changed && READ_TEXT_MIMES.has(target.mime) && llm.some((m) => m.role === "user"))
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
      const filename = sanitizeFilename(file.name);
      const mime = storedMime(file.type, filename);
      if (!mime) throw new HttpError(415, "unsupported_type", "이미지, PDF, 텍스트 파일만 올릴 수 있어요");
      let threadId: string | null = null;
      const t = form.get("threadId");
      if (typeof t === "string" && t) {
        if (!db.threadFor(t, userId)) throw notFound("대화를 찾을 수 없어요");
        threadId = t;
      }
      const id = newId("f");
      await mkdir(join(core.cfg.dataDir, "attachments", userId), { recursive: true });
      await Bun.write(attachmentPath(core, userId, id), file);
      db.insertAttachment({ id, userId, threadId, filename, mime, size: file.size, now: core.now() });
      return json(attachmentView(db.getAttachment(userId, id)!), 201);
    },
    listAttachments: (_c: Ctx, userId: string) => json(db.listAttachments(userId).map(attachmentView)),
    raw: async (c: Ctx, userId: string) => {
      const a = readableAttachment(core, userId, c.params.id!);
      if (!a) throw notFound("파일을 찾을 수 없어요");
      // the file lives under its owner (a friend's photo is in their folder)
      const f = Bun.file(attachmentPath(core, a.user_id, a.id));
      if (!(await f.exists())) throw notFound("파일을 찾을 수 없어요");
      // Markdown too goes out as plain text (shown as it is, never rendered)
      const type = READ_TEXT_MIMES.has(a.mime) ? "text/plain; charset=utf-8" : a.mime;
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
