/**
 * Which files can be uploaded, and the type each goes up with: photos (raster only), PDF and text files — .txt, and
 * .md/.markdown, opened as plain text like .txt (never drawn as markdown). No other text/*, no SVG. Constants and pure
 * functions only (no React, screen or api imports).
 *
 * Used by: screens/more/archive/UploadSheet (보관함에 올리기) and screens/chat/Composer (its file picker), so a file one
 * of them takes, the other takes too (DD 1736 §5).
 *
 * Where the rules come from: apps/server/src/archive.ts — allowedMime (the types taken) and storedMime (a file with no
 * type or `application/octet-stream`, which iOS can send and browsers do for .md, is told by its extension). Here that
 * covers .txt, .md, .markdown and .pdf; storedMime does not do it for .pdf: a .pdf sent as octet-stream is taken today
 * only because Bun's multipart parser types a file part by its name's extension.
 */

/** the 파일 고르기 picker's `accept` (the composer puts its photo types before it) */
export const FILE_ACCEPT = "application/pdf,text/plain,text/markdown,.pdf,.txt,.md,.markdown";

const MAX = 10 * 1024 * 1024;
const BY_EXTENSION = new Map([
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["pdf", "application/pdf"],
]);

const bare = (type: string) => type.toLowerCase().split(";")[0]!.trim();

/** the type the file goes up with: the browser's (lower case, no parameters), told by the extension when it gave none or application/octet-stream */
export function uploadType(f: Pick<File, "name" | "type">): string {
  const type = bare(f.type);
  if (!type || type === "application/octet-stream") {
    const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase();
    return (ext && BY_EXTENSION.get(ext)) || type;
  }
  return type === "text/x-markdown" ? "text/markdown" : type;
}

/** a type the server takes (archive.ts allowedMime) */
export function uploadTaken(type: string): boolean {
  const t = bare(type);
  return t === "application/pdf" || t === "text/plain" || t === "text/markdown" || t === "text/x-markdown" || /^image\/(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/.test(t);
}

/** why 보관함에 올리기 does not take the file (the sheet says it), or null. The composer keeps its own words. */
export function checkFile(f: Pick<File, "name" | "type" | "size">): string | null {
  if (f.size > MAX) return "10MB보다 큰 파일은 올릴 수 없어요. 크기를 줄여서 다시 올려 주세요.";
  if (f.size === 0) return "빈 파일은 올릴 수 없어요.";
  const type = uploadType(f);
  if (type === "image/svg+xml") return "SVG 그림은 올릴 수 없어요. PNG나 JPG로 올려 주세요.";
  if (!uploadTaken(type)) return "사진, PDF, 텍스트 파일만 올릴 수 있어요.";
  return null;
}

/** the file as it goes up: carrying the type uploadType gave (same name and bytes), or the file itself when that is its type */
export function withUploadType(f: File): File {
  const type = uploadType(f);
  return type && type !== f.type ? new File([f], f.name, { type, lastModified: f.lastModified }) : f;
}
