import { FILE_ACCEPT, uploadTaken, withUploadType } from "../../lib/uploadTypes";
import { MAX_CHARS } from "./util";

/**
 * What the composer takes as files, and the text that goes as a file instead of a message.
 * - Files: what 보관함에 올리기 takes, by the same rules (lib/uploadTypes.ts, DD 1736 §5): its picker list after the
 *   photo types (the picker lists .md only by its extension on iOS), the type a file goes up with (the extension
 *   decides when the browser gave none or application/octet-stream) and the types the server takes.
 * - A message holds at most MAX_CHARS characters (the server's MAX_MESSAGE_CHARS). Longer text goes as a .txt
 *   attachment (`textFile`), named after a short first line (`textFileName`).
 */
export const ACCEPT = `image/png,image/jpeg,image/gif,image/webp,image/heic,${FILE_ACCEPT}`;

/** `file` as it goes up, with the type lib/uploadTypes gives it (the same object when it has it already); null when the
 *  server does not take that type */
export function asUpload(file: File): File | null {
  const up = withUploadType(file);
  return uploadTaken(up.type) ? up : null;
}

/** more than a message holds: it goes as a file */
export const tooLongForMessage = (text: string) => text.length > MAX_CHARS;

const NAME_MAX = 24;
/** heads in front: # and > (any number), then one list mark (- * +, or a 1–3 digit number not followed by another
 *  number: "2026. 11. 26." is a date) with its task box ([ ] or [x]) */
const HEADS = /^(?:(?:#{1,6}|>)(?: |$))*(?:(?:[-*+](?: |$)|\d{1,3}[.)](?: (?!\d)|$))(?:\[[ xX]\](?: |$))?)?/;
/** a first line that is code, markup or a link names nothing (DD 1736 §2, DD 2058) */
const NOT_A_NAME = /^(?:```|~~~|<)|:\/\//;
/** format characters (zero-width space, bidi controls, soft hyphen…) go like control characters; the joiners and
 *  tags that hold an emoji or a script's letters together stay */
const FORMAT = /(?![\u200c\u200d\u{e0020}-\u{e007f}])\p{Cf}/gu;

/**
 * The file name for text that goes as a file (DD 1736 §2, DD 2058): its first non-blank line, tidied — spaces
 * collapsed, the heads in front (HEADS) and * _ ` inside left out, and the characters a file name cannot hold
 * (/ \ : * ? " < > |, control and format characters, as the server's sanitizeFilename) — when that holds a letter or
 * digit and is 1–24 code points, and the line is not code, markup or a link (NOT_A_NAME); otherwise "긴 글". Never cut
 * (a cut name looks broken). A name in `taken` gets " 2", " 3"…
 */
export function textFileName(text: string, taken: readonly string[] = []): string {
  const line = (text.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? "").replace(FORMAT, "");
  const tidy = line
    .replace(/\s+/g, " ")
    .trim()
    .replace(HEADS, "")
    .replace(/[*_`/\\:?"<>|\u0000-\u001f\u007f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  const n = Array.from(tidy).length;
  const named = n >= 1 && n <= NAME_MAX && /[\p{L}\p{N}]/u.test(tidy) && !NOT_A_NAME.test(line.trim());
  const base = named ? tidy : "긴 글";
  let name = `${base}.txt`;
  for (let k = 2; taken.includes(name); k++) name = `${base} ${k}.txt`;
  return name;
}

/** the .txt that carries `text` (text/plain, UTF-8) */
export const textFile = (text: string, name: string) => new File([text], name, { type: "text/plain" });
