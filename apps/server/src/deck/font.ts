/**
 * The deck's font (lead 0102 option 가; DD 0103-b E, F). The server takes the font file's path from PICKLE_DECK_FONT and
 * checks the file once: an sfnt (TrueType or OpenType outlines) whose name table calls its family "Noto Sans KR" and
 * whose fvar has a wght axis reaching from 400 to 900, the weights the deck draws. No path, a file that cannot be read,
 * or a file that is some other font: the deck is off on this server, and the reason is a sentence. Another font is never
 * put in its place. No font file lives in the repository.
 */

export const DECK_FONT_FAMILY = "Noto Sans KR";
/** the lightest and heaviest weight the deck's CSS asks for */
export const DECK_FONT_WEIGHTS: readonly [number, number] = [400, 900];
/** the invest screen's ⑤ row when the server has no font (DD 0103-b E) */
export const NO_FONT_ROW = "이 서버에는 글꼴 파일이 없어서 심층판을 만들지 않아요.";
/** a deck a person asked for, refused for want of the font: the failure card's reason, no retry (DD 0103-b F) */
export const NO_FONT_FAIL = "이 서버에 글꼴 파일이 없어서 심층판을 만들지 못했어요.";

export type FontOff = "no_path" | "unreadable" | "not_font" | "wrong_family" | "no_wght";

export type DeckFont =
  | { ok: true; path: string; family: string; wght: readonly [number, number]; bytes: number }
  | { ok: false; reason: FontOff; detail: string };

export interface FontFacts {
  /** the typographic family (name ID 16), else the family (name ID 1), from a Windows Unicode or Mac Roman record */
  family: string | null;
  /** the wght axis's minimum and maximum, or null when the font has no fvar or no wght axis */
  wght: [number, number] | null;
}

const tag = (v: DataView, at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

/** the name table's family and the fvar's wght axis; null when the bytes are not an sfnt this can read */
export function fontFacts(bytes: Uint8Array): FontFacts | null {
  if (bytes.length < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = v.getUint32(0);
  // 0x00010000 TrueType, OTTO CFF outlines, "true" old Apple TrueType; a collection (ttcf) is not read
  if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) return null;
  const count = v.getUint16(4);
  if (12 + count * 16 > bytes.length) return null;
  const tables = new Map<string, { at: number; len: number }>();
  for (let i = 0; i < count; i++) {
    const r = 12 + i * 16;
    const at = v.getUint32(r + 8);
    const len = v.getUint32(r + 12);
    if (at + len > bytes.length) return null;
    tables.set(tag(v, r), { at, len });
  }
  const name = tables.get("name");
  if (!name || name.len < 6) return null;

  // name: the family as the font calls it; a Windows (3, 1 or 10) record before a Mac Roman (1, 0) one
  const records = v.getUint16(name.at + 2);
  const strings = name.at + v.getUint16(name.at + 4);
  if (6 + records * 12 > name.len) return null;
  const found = new Map<string, string>();
  for (let i = 0; i < records; i++) {
    const r = name.at + 6 + i * 12;
    const [platform, encoding, , id, len, off] = [0, 2, 4, 6, 8, 10].map((k) => v.getUint16(r + k)) as [number, number, number, number, number, number];
    if (id !== 1 && id !== 16) continue;
    const s = strings + off;
    if (s + len > name.at + name.len) continue;
    let text: string | null = null;
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      text = "";
      for (let k = 0; k + 1 < len; k += 2) text += String.fromCharCode(v.getUint16(s + k));
    } else if (platform === 1 && encoding === 0) {
      text = "";
      for (let k = 0; k < len; k++) text += String.fromCharCode(v.getUint8(s + k));
    }
    if (text == null) continue;
    const key = `${id}:${platform === 3 ? "w" : "m"}`;
    if (!found.has(key)) found.set(key, text);
  }
  const family = found.get("16:w") ?? found.get("16:m") ?? found.get("1:w") ?? found.get("1:m") ?? null;

  // fvar: the wght axis, Fixed 16.16
  let wght: [number, number] | null = null;
  const fvar = tables.get("fvar");
  if (fvar && fvar.len >= 16) {
    const axesAt = fvar.at + v.getUint16(fvar.at + 4);
    const axes = v.getUint16(fvar.at + 8);
    const size = v.getUint16(fvar.at + 10);
    for (let i = 0; i < axes; i++) {
      const r = axesAt + i * size;
      if (size < 20 || r + 20 > fvar.at + fvar.len) break;
      if (tag(v, r) === "wght") wght = [v.getInt32(r + 4) / 65536, v.getInt32(r + 12) / 65536];
    }
  }
  return { family, wght };
}

/** whether the facts are the deck's font, and if not, why */
export function judgeFont(facts: FontFacts | null): { ok: true } | { ok: false; reason: FontOff; detail: string } {
  if (!facts) return { ok: false, reason: "not_font", detail: "글꼴 파일로 읽을 수 없어요" };
  if (facts.family !== DECK_FONT_FAMILY) return { ok: false, reason: "wrong_family", detail: `글꼴 이름이 ${DECK_FONT_FAMILY}가 아니에요(${facts.family ?? "없음"})` };
  const [lo, hi] = DECK_FONT_WEIGHTS;
  if (!facts.wght || facts.wght[0] > lo || facts.wght[1] < hi) return { ok: false, reason: "no_wght", detail: `굵기 축(wght)이 ${lo}–${hi}를 덮지 않아요` };
  return { ok: true };
}

/**
 * The deck's font on this server, from the path PICKLE_DECK_FONT names (the caller passes it in). Read once at startup;
 * every failure is a reason and a sentence, never an exception.
 */
export async function loadDeckFont(path: string | undefined, read: (p: string) => Promise<Uint8Array> = readFile): Promise<DeckFont> {
  if (!path || !path.trim()) return { ok: false, reason: "no_path", detail: "PICKLE_DECK_FONT가 비었어요" };
  let bytes: Uint8Array;
  try {
    bytes = await read(path);
  } catch {
    return { ok: false, reason: "unreadable", detail: "글꼴 파일을 읽지 못했어요" };
  }
  const facts = fontFacts(bytes);
  const j = judgeFont(facts);
  if (!j.ok) return j;
  return { ok: true, path, family: facts!.family!, wght: facts!.wght!, bytes: bytes.length };
}

async function readFile(p: string): Promise<Uint8Array> {
  const { readFile: rf } = await import("node:fs/promises");
  return new Uint8Array(await rf(p));
}

/** the CSS src for the PDF pass: the file itself, by URL (never embedded in the archived HTML) */
export function fontFileSrc(path: string): string {
  const url = new URL(`file://${path.startsWith("/") ? "" : "/"}${path}`).href;
  return `url("${url}") format("truetype")`;
}
