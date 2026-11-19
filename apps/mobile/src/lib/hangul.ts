/**
 * Korean search helpers: 초성 (initial-consonant) matching for Spotlight and any filter field.
 *
 *   choseong("기본 채팅")            → "ㄱㅂ ㅊㅌ"   (one output char per input UTF-16 unit, so indices map back)
 *   matchKorean("둘러보기", "ㄷㄹㅂ") → { score, ranges: [[0, 3]] }
 *   filterKorean(items, q, getLabel) → [{ item, score, ranges }] best first
 *
 * A query may be plain text (case-insensitive substring), only jamo consonants ("ㅂㄱㅎ"), or mixed ("둘ㄹ보").
 * Spaces are ignored when matching initials, so "ㄱㅂㅊㅌ" and "ㄱㅂ ㅊㅌ" both find "기본 채팅". The last syllable
 * of a query also matches a label syllable it is still being composed into ("보과" finds "보관함" mid-IME).
 */

const SYLLABLE_FIRST = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const CHO_SET = new Set(CHO);

const isSyllable = (code: number) => code >= SYLLABLE_FIRST && code <= SYLLABLE_LAST;
const isSpace = (ch: string) => /\s/.test(ch);

/** True for a compatibility-jamo consonant (ㄱ–ㅎ) that can stand for a syllable's initial. */
export const isJamoConsonant = (ch: string) => CHO_SET.has(ch);

/** Initial consonant of one character (lowercased passthrough for anything that is not a Hangul syllable). */
function initialOf(ch: string): string {
  const code = ch.charCodeAt(0);
  if (!isSyllable(code)) return ch.toLowerCase();
  return CHO[Math.floor((code - SYLLABLE_FIRST) / 588)];
}

/** Hangul syllables → initial consonants; other characters pass through lowercased. Same length as the input. */
export function choseong(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += initialOf(text[i]);
  return out;
}

/** The query is made only of jamo consonants (spaces allowed). */
export function isChoseongQuery(q: string): boolean {
  let any = false;
  for (const ch of q) {
    if (isSpace(ch)) continue;
    if (!isJamoConsonant(ch)) return false;
    any = true;
  }
  return any;
}

export interface KoreanMatch {
  /** higher is better */
  score: number;
  /** [start, end) ranges in the label (UTF-16 indices) to highlight */
  ranges: [number, number][];
}

function decompose(code: number) {
  const idx = code - SYLLABLE_FIRST;
  return { initial: Math.floor(idx / 588), medial: Math.floor((idx % 588) / 28), final: idx % 28 };
}

/** Does one query character stand for one label character? */
function charMatches(q: string, l: string, isLastQueryChar: boolean): boolean {
  if (isJamoConsonant(q)) return initialOf(l) === q;
  const qc = q.charCodeAt(0);
  const lc = l.charCodeAt(0);
  if (q.toLowerCase() === l.toLowerCase()) return true;
  // a syllable still being composed (no final yet) matches a label syllable with the same initial + medial
  if (isLastQueryChar && isSyllable(qc) && isSyllable(lc)) {
    const a = decompose(qc);
    const b = decompose(lc);
    return a.final === 0 && a.initial === b.initial && a.medial === b.medial;
  }
  return false;
}

const isWordStart = (label: string, i: number) => i === 0 || isSpace(label[i - 1]) || /[-_/·(]/.test(label[i - 1]);

function toRanges(indices: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const i of indices) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/**
 * Match a label against a query. Returns null when it does not match. An empty query matches everything with score 0.
 * Scoring: plain substring (100) > initials/mixed (60); a match at the start (+30) or at a word start (+15) ranks
 * higher; earlier matches rank higher.
 */
export function matchKorean(label: string, query: string): KoreanMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const lower = label.toLowerCase();

  // 1. plain substring (keeps spaces as typed)
  const at = lower.indexOf(q);
  if (at >= 0) {
    const bonus = at === 0 ? 30 : isWordStart(label, at) ? 15 : 0;
    return { score: 100 + bonus - at * 0.5 - (label.length - q.length) * 0.05, ranges: [[at, at + q.length]] };
  }

  // 2. initials / mixed, contiguous over non-space characters on both sides
  const qs = [...q].filter((ch) => !isSpace(ch));
  if (!qs.length) return null;
  const idx: number[] = [];
  for (let i = 0; i < label.length; i++) if (!isSpace(label[i])) idx.push(i);
  for (let s = 0; s + qs.length <= idx.length; s++) {
    let ok = true;
    for (let k = 0; k < qs.length; k++) {
      if (!charMatches(qs[k], label[idx[s + k]], k === qs.length - 1)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = idx[s];
    const bonus = start === 0 ? 30 : isWordStart(label, start) ? 15 : 0;
    return { score: 60 + bonus - start * 0.5 - (label.length - qs.length) * 0.05, ranges: toRanges(idx.slice(s, s + qs.length)) };
  }
  return null;
}

export interface KoreanResult<T> extends KoreanMatch {
  item: T;
}

/**
 * Filter + rank items by their label (highlight ranges refer to the label) and optional extra keywords (ranked lower,
 * no highlight). An empty query returns every item in its original order.
 */
export function filterKorean<T>(items: readonly T[], query: string, getLabel: (item: T) => string, extra?: (item: T) => string[] | undefined): KoreanResult<T>[] {
  const out: (KoreanResult<T> & { order: number })[] = [];
  items.forEach((item, order) => {
    const m = matchKorean(getLabel(item), query);
    if (m) {
      out.push({ item, order, ...m });
      return;
    }
    const words = extra?.(item);
    if (!words) return;
    let best: number | null = null;
    for (const w of words) {
      const km = matchKorean(w, query);
      if (km && (best === null || km.score > best)) best = km.score;
    }
    if (best !== null) out.push({ item, order, score: best - 40, ranges: [] });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map(({ item, score, ranges }) => ({ item, score, ranges }));
}
