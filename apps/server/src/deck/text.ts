/**
 * The deck's words: figures written with the §0-5 formatter, the model's text with its `{id}` references filled, and
 * the checks on what the model wrote (FA4 #6, #9, #10; DD 1935 §0-6). The model writes no number: a digit in its text is
 * allowed only inside a date, a time or a name (MA20, S&P 500, 10년물), never as a figure.
 */
import { krw, num, pct, pp, rate, UNKNOWN_TEXT, usd } from "@pickle/quant";
import type { DeckFigure } from "./types";

/** a reference in the model's text: {vix}, {soxl.close} */
export const REF_RE = /\{([A-Za-z0-9_.:-]{1,40})\}/g;

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** a figure's parts: the number, and the estimate's 약 … (추정) around it (drawn smaller beside a hero number) */
export function figureParts(f: DeckFigure): { pre: string; main: string; post: string } {
  const v = f.value;
  if (v == null || !Number.isFinite(v)) return { pre: "", main: UNKNOWN_TEXT, post: "" };
  const d = f.digits;
  let main: string;
  switch (f.format) {
    case "usd":
      main = usd(v);
      break;
    case "krw":
      main = krw(v);
      break;
    case "index":
      main = num(v, d ?? 2);
      break;
    case "rate":
      main = rate(v, d ?? 2);
      break;
    case "pct":
      main = pct(v, d ?? 2);
      break;
    case "pp":
      main = pp(v, d ?? 2);
      break;
    case "spread":
      // a spread's level is a difference too, written %p, without a sign of its own (DD 1520)
      main = `${num(v, d ?? 2)}%p`;
      break;
    case "count":
      main = `${num(v, d ?? 0)}${f.unit ?? ""}`;
      break;
    case "multiple":
      main = `${num(v, d ?? 1)}배`;
      break;
    case "pm":
      main = `±${num(Math.abs(v), d ?? 1)}%`;
      break;
  }
  return f.estimate ? { pre: "약 ", main, post: "(추정)" } : { pre: "", main, post: "" };
}

export function figureText(f: DeckFigure): string {
  const p = figureParts(f);
  return p.pre + p.main + p.post;
}

/** the characters a person counts: graphemes, not UTF-16 units */
export function chars(s: string): number {
  return [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(s)].length;
}

export interface Filled {
  /** as read: references replaced by their figures */
  plain: string;
  /** escaped HTML, each figure in <span class="fig"> */
  html: string;
  /** the ids it used, and those the data does not have */
  refs: string[];
  missing: string[];
}

/** a text of the model's with its references filled; `words` are the server's phrases the model may also name
 * ({escape_label} → 2단계 경계) */
export function fill(text: string, figures: Readonly<Record<string, DeckFigure>>, words: Readonly<Record<string, string>> = {}): Filled {
  const refs: string[] = [];
  const missing: string[] = [];
  let plain = "";
  let html = "";
  let at = 0;
  for (const m of text.matchAll(REF_RE)) {
    const id = m[1]!;
    const before = text.slice(at, m.index);
    plain += before;
    html += esc(before);
    const f = figures[id];
    const w = words[id];
    if (f) {
      refs.push(id);
      const s = figureText(f);
      plain += s;
      html += `<span class="fig" data-ref="${esc(id)}">${esc(s)}</span>`;
    } else if (w != null) {
      refs.push(id);
      plain += w;
      html += `<span class="fig" data-ref="${esc(id)}">${esc(w)}</span>`;
    } else {
      missing.push(id);
      plain += m[0];
      html += esc(m[0]);
    }
    at = m.index! + m[0].length;
  }
  const rest = text.slice(at);
  return { plain: plain + rest, html: html + esc(rest), refs, missing };
}

/**
 * Digits the model may write: dates and times (2026년, 11월 27일, 08:00, 3분기), tenors and windows (10년물, 20거래일,
 * 3개월, 20일선), level ordinals (1차), D-1, upper-case names with digits (MA20, HBM3E, G7, D7, Q3) and a few index
 * names. A slash date (11/27) is not allowed: it reads like a count (3/8). Everything else with a digit is a figure,
 * and figures come from the data.
 */
const ALLOWED_DIGITS: readonly RegExp[] = [
  /\d{4}년/g,
  /\d{4}-\d{1,2}-\d{1,2}/g,
  /\d{1,2}월(\s?\d{1,2}일)?/g,
  /\d{1,2}일(?=[\s(]|$)/g,
  /\d{1,2}:\d{2}/g,
  /\d{1,2}시(\s?\d{1,2}분)?/g,
  /[1-4]분기/g,
  /\d{1,2}년물/g,
  /\d{1,3}(거래일|영업일|개월|주일?|년)(?![0-9])/g,
  /\d{1,3}(일선|주선)/g,
  /[1-3]차(?![0-9])/g,
  /D-\d{1,2}/g,
  /\b[A-Z]{1,5}\d{1,4}[A-Z]?\b/g,
  /S&P\s?500|나스닥\s?100|러셀\s?2000|코스피\s?200|KOSPI\s?200|닛케이\s?225|Nikkei\s?225/g,
  /11지표/g,
];

const ADVERBS = ["매우", "엄청", "굉장히", "정말", "극도로", "완전히", "폭발적", "역대급"];
const HYPE = ["혁신적", "게임체인저", "획기적", "압도적", "판도를 바꿀"];
/** DD 1935 §0-6: no recommendation, no promise */
const ADVICE = ["사세요", "파세요", "매수하세요", "매도하세요", "기회예요", "기회입니다", "지금이 기회", "꼭 사", "꼭 팔", "할 때예요", "할 때입니다"];

export interface TextFault {
  rule: string;
  what: string;
}

/** the checks on one text of the model's (after its references are taken out) */
export function lintModelText(text: string): TextFault[] {
  const out: TextFault[] = [];
  let rest = text.replace(REF_RE, " ");
  for (const re of ALLOWED_DIGITS) rest = rest.replace(re, " ");
  const digit = rest.match(/[^\s]*\d[^\s]*/);
  if (digit) out.push({ rule: "FA4-9", what: `숫자는 데이터 id로 써요: "${digit[0]}"` });
  if (/\p{Extended_Pictographic}/u.test(text)) out.push({ rule: "FA4-10", what: "이모지가 있어요" });
  if (/[!！]/.test(text)) out.push({ rule: "FA4-10", what: "느낌표가 있어요" });
  for (const w of ADVERBS) if (text.includes(w)) out.push({ rule: "FA4-10", what: `과장 부사 "${w}"` });
  for (const w of HYPE) if (text.includes(w)) out.push({ rule: "FA4-6", what: `수사 "${w}"` });
  for (const w of ADVICE) if (text.includes(w)) out.push({ rule: "copy", what: `권유하는 말 "${w}"` });
  return out;
}

/** a sentence the slide carries (FA4 #1 counts those over 40 characters) */
export const isSentence = (s: string) => /(요|다|음|함|임)[.]?$/.test(s.trim()) || /[.?]$/.test(s.trim());
