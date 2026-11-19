/**
 * The app's `glued()` (apps/mobile/src/ui/Text.tsx, snap-fnd-em) for the agent's HTML cards: the same spots, cut
 * from the same source line for line, with the output as pieces (text, a glued run, a break box) instead of React
 * nodes. `gluedHtml` escapes each piece on its own, so no span edge falls inside an entity ("&amp;", "&#39;"). The card
 * sheet carries the two classes itself (`.t-glue{white-space:pre}.t-brk{display:inline-block}`): the app's CSS does not
 * reach the card frame. Kept in step with Text.tsx by test/glue.test.ts's cases and the parity check over the app's
 * cases (design-director 2026-11-18 12:57, deep-37).
 */

/** a piece of glued text: plain text, a glued run (`.t-glue`), or a break box (`.t-brk`) */
export type GluePiece = string | { glue: string } | { brk: true };
const BRK: GluePiece = { brk: true };

// what goes on a cluster with nothing to go on: a mark, a joiner, a tag, a halfwidth sound mark
const LOOSE = "\\p{M}\\u200c\\u200d\\u{e0020}-\\u{e007f}\\uff9e\\uff9f";
// the marks of scripts this system has a font for (measured on their own letters): Latin, Greek and Cyrillic and the
// shared combining blocks, Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, the Indic scripts and Sinhala,
// Thai, Lao, Tibetan, Myanmar, Khmer, Mongolian, kana's sound marks, the variation selectors
const FONT_MARKS =
  "\\u0300-\\u036f\\u0591-\\u05c7\\u0610-\\u061a\\u064b-\\u065f\\u0670\\u06d6-\\u06ed\\u0711\\u0730-\\u074a" +
  "\\u07a6-\\u07b0\\u07eb-\\u07f3\\u07fd\\u0816-\\u082d\\u0859-\\u085b\\u0897-\\u089f\\u08ca-\\u08ff\\u0900-\\u0dff" +
  "\\u0e31-\\u0e3a\\u0e47-\\u0e4e\\u0eb1-\\u0ebc\\u0ec8-\\u0ece\\u0f18\\u0f19\\u0f35\\u0f37\\u0f39\\u0f3e\\u0f3f" +
  "\\u0f71-\\u0f84\\u0f86\\u0f87\\u0f8d-\\u0fbc\\u0fc6\\u102b-\\u103e\\u1056-\\u1059\\u105e-\\u1060\\u1062-\\u1064" +
  "\\u1067-\\u106d\\u1071-\\u1074\\u1082-\\u108d\\u108f\\u109a-\\u109d\\u17b4-\\u17d3\\u17dd\\u180b-\\u180d\\u180f" +
  "\\u1885\\u1886\\u18a9\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\u3099\\u309a\\ufe00-\\ufe0f\\ufe20-\\ufe2f" +
  "\\u{e0100}-\\u{e01ef}";
/**
 * a character WebKit lays the text box holding it out at a width other than the one it draws it at, by up to a
 * character's width either way: what follows the box on its line moves by the difference ("(#️⃣ 번호)" with "(#️⃣" in
 * a span: "번" 10 px to the right at 17 px; with "‼️" 13 px to the left, over it). Plain text has the error at the
 * line's end, where nothing follows. Chrome draws them right. They are a keycap frame, a style selector or a skin
 * tone on # * ‼ ⁉ 〽 ("#️⃣", "*️⃣", "‼️", "⁉️", "〽️"; not on the digits: "1️⃣"), a style selector or keycap frame on
 * no emoji, a skin tone on no emoji that takes one, a mark, joiner or tag with no letter, digit or emoji under it, a
 * mark of a script with no font here, the Hangul fillers and Apple's private-use tags. Measured at 17 and 22 px, the
 * text box's end against plain text: 7,190 emoji sequences (each emoji alone, with FE0F, FE0E, 20E3, FE0F 20E3), 8,643
 * skin tone pairs, 39,195 selectors and frames on other characters up to U+33FF, 203,926 single characters (planes 0
 * and 1, every 7th of 2 and 3, after a space and after Hangul) and 9,460 marks on letters of their own script: 4,517
 * moved past 1.6 px in WebKit, all found here. In saved text: none of the 21,462 strings of the reply rows, one of
 * 7,751 result strings (a private-use character with FE0E)
 */
const ODD = new RegExp(
  "[#*\\u203c\\u2049\\u303d](?=[\\ufe0e\\ufe0f\\u20e3\\u{1f3fb}-\\u{1f3ff}])|" +
    "(?<!\\p{Emoji}\\ufe0f?)[\\ufe0e\\ufe0f\\u20e3]|" +
    `(?<!\\p{Emoji_Modifier_Base})\\p{Emoji_Modifier}|(?<![\\p{L}\\p{N}\\p{Emoji}${LOOSE}])[${LOOSE}]|` +
    `(?![${FONT_MARKS}])\\p{M}|[\\u3164\\uffa0\\uf86c-\\uf89f]`,
  "uy",
);
// where `ODD` may match: one class, so a text with none (most) is read once, without the lookbehinds
const ODD_AT = new RegExp(`[#*\\u203c\\u2049\\u303d\\p{Emoji_Modifier}\\u3164\\uffa0\\uf86c-\\uf89f${LOOSE}]`, "gu");
/** where the first character `ODD` holds is, from `i` on (-1: none) */
function oddFrom(s: string, i: number): number {
  ODD_AT.lastIndex = i;
  for (let m = ODD_AT.exec(s); m; m = ODD_AT.exec(s)) if (((ODD.lastIndex = m.index), ODD.test(s))) return m.index;
  return -1;
}

// glued spots (`glued`): an opening bracket or quote, a closing one, "。" or "、", a digit, a dash before a digit, a
// "·" after a space, a "·" inside a word
const SPOT = /[(（「『【〔“‘)）」』】〕”’。、\d]|[–-](?=\d)| ·|(?<=\S)·/gu;
const OPENS = /[(（「『【〔“‘]/u;
// a number from its first digit, separators inside ("10,200", "2.5", "10:30", "1/2", "03-5579-5993"), and % ‰ ° ℃
// when a letter follows ("93%가"); sticky, and linear: each repeat takes a separator and a digit
const NUMBER = /\d+(?:[.,:/–-]\d+)*(?:[%‰°℃](?=\p{L}))?/uy;
// what a closing bracket or quote is glued to after it: a mark, or a letter or digit of its word ("),", "」。", ")을",
// "”처럼"); before it, the character it closes on ("원)", "ク)"). Kana and kanji are not taken: a line may start on
// them after a closing bracket (Japanese breaks there, Korean before a particle does not)
const KANA_KANJI = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const AFTER_CLOSE = /[,.:;!?、。]|(?![\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[\p{L}\p{N}]/u;
// a glued run ending on one of these keeps the break plain text has after it before kana, kanji or an opener: WebKit
// drops a break at the end of a nowrap span there ("す。|初診", "」|当日"), a break box (`brk`) puts it back
const BREAK_END = /[)）」』】〕。、]/u;
// what goes on a grapheme cluster at its place (UAX #29 Extend, SpacingMark, ZWJ, V and T: a mark, a joiner, a skin
// tone, a variation selector, a tag, a vowel or final jamo; then the few that are not marks: Thai and Lao AM, the
// halfwidth sound marks, Kirat Rai vowels, Apple's private-use tags), what joins the next character to it (a joiner, a
// virama before a consonant: GB9c; Prepend), a regional indicator (a flag is a pair), a leading jamo and a syllable
// (both go on after a leading jamo). Checked against Intl.Segmenter over every code point
const GOES_ON = /[\p{M}\p{Emoji_Modifier}\u200c\u200d\u{e0020}-\u{e007f}\u1160-\u11ff\ud7b0-\ud7ff]/u;
const GOES_ON_TOO = /[\u0e33\u0eb3\uff9e\uff9f\u{16d63}\u{16d67}-\u{16d6a}\uf870-\uf89f]/u;
const JOINS_NEXT = /[\u200d\u094d\u09cd\u0acd\u0b4d\u0c4d\u0d4d]/u;
const PREPEND = /[\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u0d4e\u{110bd}\u{110cd}\u{111c2}\u{111c3}\u{113d1}]/u;
const PREPEND_TOO = /[\u{1193f}\u{11941}\u{11a84}-\u{11a89}\u{11d46}\u{11f02}]/u;
const RI = /[\u{1f1e6}-\u{1f1ff}]/u;
const LEAD_JAMO = /[\u1100-\u115f\ua960-\ua97f]/u;
const SYLLABLE = /[\uac00-\ud7a3]/u;
// a cluster goes on at the sticky index: one test, no string made
const INSIDE = new RegExp(
  `${GOES_ON.source}|${GOES_ON_TOO.source}|(?<=${JOINS_NEXT.source}|${PREPEND.source}|${PREPEND_TOO.source})|` +
    `(?<=${RI.source})${RI.source}|(?<=${LEAD_JAMO.source})(?:${LEAD_JAMO.source}|${SYLLABLE.source})`,
  "uy",
);
const HIGH = /[\ud800-\udbff]/;
const LOW = /[\udc00-\udfff]/;
// a URL, a domain, a mail address or a handle in plain text (a link is a run of its own, not glued): a piece between
// spaces, cut before openers ("clinic.com" and "(810곳"), with "://", "www.", "@x" or "x.yy" in it. One too long for a
// glued run (past 16 characters or 9 em) is left plain: WebKit drops the breaks inside a piece with a box edge on it
// and cuts it where it overflows ("seoul.go.k / r)에서" with "[(p]" and "[r)에]" glued, "manjar / o/)" with "[(o]" or
// "[(]" alone; "seoul.go. / kr" plain). A shorter one never breaks inside: glued as any text
const URL_PIECE = /[^\s(（「『【〔“‘]+|[(（「『【〔“‘][^\s(（「『【〔“‘]*/gu;
const URLISH = /:\/\/|www\.|@[A-Za-z0-9_]|[A-Za-z0-9-]\.[A-Za-z]{2,}/;
// a glued run's width in em, never under the system font's (measured at text size 130 %, both engines; `em` counts
// digits, emoji, W and % 0.6, under their width): digits 0.62 (0.44–0.615); Hangul, kana, Han and full-width forms 1
// (0.865); ( ) “ ” ‘ ’ 0.4 (0.23–0.40); "-" 0.45 (0.44); "–" 0.55 (0.54); "/", a space and . , : ; · ! 0.3 (0.24–0.28);
// anything else 1.25 (W 0.93, % 0.85, ℃ 1.12, ‰ 1.21, emoji 1.04–1.18)
const glueEm = (s: string) =>
  [...s].reduce(
    (n, c) =>
      n +
      (/\d/.test(c)
        ? 0.62
        : /[\u1100-\u11ff\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/u.test(c)
          ? 1
          : /[()“”‘’]/.test(c)
            ? 0.4
            : c === "-"
              ? 0.45
              : c === "–"
                ? 0.55
                : /[/\s.,:;·!]/.test(c)
                  ? 0.3
                  : 1.25),
    0,
  );
// the longest glued run, side by side spots together: 16 characters and 9 em by `glueEm`, 199 px at text size 130 %,
// inside the narrowest column at 320 (the owner's bubble 208 px, a reply's list item two levels deep 212 px, both
// engines): "(010-1234-5678)" is 8.5 em, "(0120-151-929)이" 8.9
const GLUE_MAX = 16;
const GLUE_EM = 9;
// spans and break boxes in one call at most: a 30,000-character reply holds about 900; past this the text stays plain,
// so a hostile one (a megabyte of brackets) costs no more than a long reply
const GLUE_SPANS = 2000;
// a break with no character: an empty inline-block (.t-brk), a break before and after it in both engines (CSS Text 3
// § 5.1: around an atomic inline, keep-all or not). Not <wbr>: with a <wbr> earlier in the paragraph, WebKit draws the
// space before a glued span at a line's start (+4 px at 4 of 76 widths, DD's case; 0 with the box)
const brk = (_key: string): GluePiece => BRK;

/**
 * Flowing text that does not go through `tied()` (a chat reply's text runs, a stream; a link run is not glued): each
 * spot where a browser breaks inside a word under keep-all becomes a nowrap inline (`.t-glue`, not a box, so nothing
 * else in the line moves). No character is added (the nodes' text is the input):
 *   - an opening bracket or quote and what follows it: the whole number ("(2.5", "(1,000"), else one character
 *     ("(내", "「今"). WebKit ends lines on it ("8,000엔( / 내원)"), Chrome does not. After a character it gets a break
 *     box before it (`.t-brk`) and joins no run before: keep-all leaves no break there, and the glued "(달" made the
 *     whole word one unit that broke inside ("과의원(달빛어린 / 이병원)" → "과의원 / (달빛어린이병원)");
 *   - a number with a separator inside ("10,200", "2.5", "10:30", "2026-11-17", "03-5579-5993"), and one with % ‰ ° ℃
 *     and the letter after it ("93%가"): WebKit breaks at . , : / – ("10, / 200엔"), Chrome after - and – and between %
 *     and the Hangul after it;
 *   - a dash inside a word and the number after it ("일–28", "시-12", "KF-94"): Chrome breaks after the dash;
 *   - a closing bracket or quote with what it closes on (the character before it, or the whole number) and the mark
 *     or letter right after it ("원)", "화),", "は」。", "트)을", "줘”처", "(0120-151-929)이"): a line would open with
 *     ")" or the mark, or the word's end would go down alone. Kana and kanji after it are not taken (Japanese breaks
 *     there);
 *   - "。" or "、" with the character before it ("す。", "ど、"): WebKit opens lines with them;
 *   - " ·" after a word, the space and "·" ("닉 ·" holds " ·"), when the word (from a break box in it) and " ·" fit a
 *     glued run: a line would open with "·";
 *   - "·" inside a word with the character before it (its whole grapheme cluster: "👍🏻·", "🇰🇷·"; the whole number for
 *     a digit) or the glued run ending there, and a break box after it when a character follows that may open a line
 *     ("전화·카카오톡" → "전[화·]|카카오톡"): Chrome breaks before it ("전화 / ·카카오톡"), WebKit never, and WebKit drops a
 *     break at a nowrap span's end, which the box puts back. At the text's start (a run after a bold name or a link)
 *     it stays plain: a span opening a run there breaks off at the element's end.
 * Nothing inside a URL-like piece too long for a glued run (a domain, a path, a mail address or handle) is glued.
 * No span or box edge falls inside a grapheme cluster (an emoji with its skin tone, joiners, style selector or keycap
 * frame, a flag, a letter with its marks, conjoining jamo, a Prepend sign with what follows, a conjunct over a virama;
 * on the safe side never between two regional indicators or after a joiner or virama): the span takes the whole
 * cluster at either end ("[(🇰🇷] 한국", "가족[👨‍👩‍👧)]"), within a glued run's length, or the spot stays
 * plain. WebKit draws a cluster cut by an edge as its pieces ("🇰🇷" as two letter boxes, "👍🏻" as a thumb and a
 * square, "👨‍👩‍👧" as three people); Chrome draws it whole. Nothing is glued from a character WebKit sizes apart
 * from how it draws it (`ODD`: "#️⃣", "‼️", a lone skin tone or mark) to the line's end: the box would move what
 * follows it on the line.
 * Spots side by side are one span, no longer than 16 characters and 9 em by `glueEm` (an upper bound of the system
 * font's widths): past that a dash or a number starts a new span after a break box (the break goes before the
 * number), a closer, "。", "、", " ·" and a word's "·" stay plain (and so does a closer right after a closing mark
 * left plain or at the text's start: no span opens on a closer), and a longer number keeps its breaks (an ID or
 * junk). A run ending on a closer, "。" or "、" before kana, kanji or an opener ends there, a break box after it:
 * WebKit drops the break plain text has there ("す。|初診"). At most 2000 spans and boxes a call. On 1576 saved reply
 * lines drawn as the chat draws them (links as links), 320–430: WebKit lines ending on an opener 1127 → 25 (each
 * before a long domain left plain), numbers cut 1917 → 0, lines opening with a mark 29 → 3, a closer's word cut
 * 81 → 1, lines opening on "·" after a space 568 → 78, breaks inside a plain word that A has not 0; Chrome numbers cut
 * 670 → 5, a closer's word cut 67 → 1, "·" after a space 548 → 80, lines opening on a word's "·" 130 → 0, breaks
 * inside a plain word 0 new; lines +0.89 % in WebKit, +0.70 % in Chrome, no line drawn indented, nothing cut off, and
 * at 320 with text size 130 % hostile lines run past no column (FOUNDATION.md › Line breaks › Flowing text).
 * `before` is the text of the run drawn right before, in the same block (the caller's previous run: a bold name, a
 * link): an opener at the text's start after a character gets a break box (WebKit cut "**하이엔소아청소년과의원**(달빛
 * 어린 / 이병원)" without it), a " ·" at the start rides on the word `before` ends on when the two fit a glued run, and
 * a word the text starts inside counts with its part in `before`. The block keeps spaces (`white-space: pre-wrap`, as
 * `.md p`): under `normal` Chrome breaks before a span that opens a run with a space after an element's end and draws
 * the space at the next line's start (+4.3 px). On 2001 saved lines whose runs meet at " ·" or an opener, list bodies
 * pre-wrap: lines opening on "·" after a space 979 → 124 (WebKit), 974 → 123 (Chrome), on a word's "·" 74 → 0
 * (Chrome; WebKit 0), breaks inside a plain word that HEAD has not 0, no line drawn indented. Returns the string
 * itself when there is nothing to glue.
 */
export function gluedPieces(text: string, before = ""): GluePiece[] {
  const out: GluePiece[] = [];
  let last = 0; // the text up to here is out
  let runStart = 0; // where the glued run ending at `glueEnd` starts (side by side spots are one span)
  let glueEnd = -1;
  let spans = 0;
  let box = -1; // where the last break box went
  // what `before` ends on: its last word (a whole word of 16 characters at most, from a break box glued() puts in it
  // before "(" after a character), for a " ·" at the text's start; and whether that is a character, for an opener at
  // the text's start (a break box before it, as inside a text: "**의원**(달빛…" → "의원 / (달빛…")
  let lead = "";
  let w0 = before.length;
  while (w0 > 0 && before.length - w0 < GLUE_MAX && !/\s/.test(before[w0 - 1])) w0--;
  if (w0 < before.length && (w0 === 0 || /\s/.test(before[w0 - 1]))) {
    lead = before.slice(w0);
    for (let k = lead.length - 2; k > 0; k--)
      if (OPENS.test(lead[k]) && !/\s/.test(lead[k - 1]) && !OPENS.test(lead[k - 1])) {
        lead = lead.slice(k);
        break;
      }
  }
  const afterChar = before !== "" && !/\s/.test(before[before.length - 1]) && !OPENS.test(before[before.length - 1]);
  const step = (i: number) => (text.codePointAt(i)! > 0xffff ? 2 : 1); // one character, a surrogate pair whole
  // the character before `i`, a surrogate pair whole
  const prevAt = (i: number) =>
    LOW.test(text[i - 1]) && HIGH.test(text[i - 2] ?? "") ? text.slice(i - 2, i) : text[i - 1];
  // a grapheme cluster goes on across `i` (on the safe side: between any two regional indicators, after any joiner or
  // virama), so no span or box edge goes there: WebKit draws a cluster cut by one as its pieces ("🇰🇷" as two letter
  // boxes, "👍🏻" as a thumb and a square, "👨‍👩‍👧" as three people)
  const inside = (i: number) => i > 0 && i < text.length && ((INSIDE.lastIndex = i), INSIDE.test(text));
  const fits = (start: number, end: number) => end - start <= GLUE_MAX && glueEm(text.slice(start, end)) <= GLUE_EM;
  // the number at `i`: [its end, the end of a glue over it (past % and its letter), or -1 when it holds no separator]
  const number = (i: number): [number, number] => {
    NUMBER.lastIndex = i;
    const n = NUMBER.exec(text)![0];
    const sign = /[%‰°℃]$/.test(n);
    return [i + n.length, sign || /\d[.,:/–-]\d/.test(n) ? i + n.length + (sign ? step(i + n.length) : 0) : -1];
  };
  // long URL-like pieces, [start, end) in order; `u` the first not ending before the spot (spots come in order)
  const urls: number[] = [];
  if (/[.@]/.test(text)) {
    URL_PIECE.lastIndex = 0;
    for (let m = URL_PIECE.exec(text); m; m = URL_PIECE.exec(text))
      if (URLISH.test(m[0]) && !fits(m.index, m.index + m[0].length)) urls.push(m.index, m.index + m[0].length);
  }
  let u = 0;
  // a character WebKit sizes apart from how it draws it (`ODD`) at `oddAt`, the end of its line (past the "\n") at
  // `oddTo`: no span or box edge in between, so the text box holding it ends where plain text's does (the line's end
  // or the run's) and nothing after it moves. Looked for when a spot passes the line before
  let oddAt = 0;
  let oddTo = 0;
  SPOT.lastIndex = 0;
  // a break after the run ending at `last`, where plain text breaks: the run ends on a closer, "。" or "、", and kana,
  // kanji or an opener follows; or it ends on "·" and a character follows (not another "·", a closer or a mark: no
  // line opens with those)
  const breakAfter = () =>
    glueEnd === last && last > 0 && last < text.length &&
    ((BREAK_END.test(text[last - 1]) &&
      (KANA_KANJI.test(String.fromCodePoint(text.codePointAt(last)!)) || OPENS.test(text[last]))) ||
      (text[last - 1] === "·" && !/[\s·)）」』】〕”’,.:;!?、。]/.test(text[last])));
  for (let m = SPOT.exec(text); m && spans <= GLUE_SPANS - 3; m = SPOT.exec(text)) {
    const at = m.index;
    while (at >= oddTo) {
      const o = oddFrom(text, oddTo);
      oddAt = o < 0 ? Infinity : o;
      const nl = o < 0 ? -1 : text.indexOf("\n", o);
      oddTo = nl < 0 ? Infinity : nl + 1;
    }
    if (at >= oddAt) {
      SPOT.lastIndex = Math.min(oddTo, text.length); // plain to the line's end
      continue;
    }
    let skip = at + 1; // where the search goes on: past a whole number, glued or not, so a digit run is read once
    let glueSkip = 0; // where the search goes on when this spot is glued (an opener's number)
    let from = at; // where the span starts: a closing bracket takes the character before it
    let end = -1;
    while (u < urls.length && urls[u + 1] <= at) u += 2;
    const url = u < urls.length && urls[u] <= at; // inside a long URL-like piece
    // an opener after a character: a break before it (a box), no join with a run before ("의원 / (달빛어린이병원)",
    // "3666 / (우메다)": keep-all leaves no break there, and a glued "(달" would make the whole word one unit)
    const opener = OPENS.test(m[0]);
    const cut = opener && (at > 0 ? !/\s/.test(text[at - 1]) && !OPENS.test(text[at - 1]) : afterChar);
    if (url) skip = urls[u + 1];
    else if (/\d/.test(m[0])) [skip, end] = number(at);
    else if (opener || /[–-]/.test(m[0])) {
      // an opening bracket's partner, or a dash's inside a word ("24일–28일": Chrome breaks after the dash; a number's
      // own dashes go with the number): a whole number when one follows and it fits, else one character (and once
      // glued, the rest of that number stays plain: its tail is not glued on its own)
      const i = at + 1;
      if (/[–-]/.test(m[0]) && (at === 0 || /\s/.test(text[at - 1]))) {
        // a dash at a word's start ("-5도"): a sign, not a spot
      } else if (i < text.length && /\d/.test(text[i])) {
        const [run, glue] = number(i);
        const whole = glue > 0 ? glue : run;
        end = fits(at, whole) ? whole : i + 1;
        glueSkip = run;
      } else if (i < text.length && !/\s/.test(text[i])) end = i + step(i);
    } else if (m[0] === " ·") {
      // a "·" between words rides on the word before it, as in `tied()` (no line opens on "·"): the space and "·" in
      // one span, joined to a glued run ending there. No line breaks before a space (UAX #14 LB7), so the word and
      // " ·" go together, and a word too wide for its line still takes its emergency break at the span's start, as
      // plain text does (a span from the word's last character split such words inside: +26 WebKit, +45 Chrome over
      // a 100–200 px sweep). The word (from the last break box in it) and " ·" fit a glued run, 16 characters and 9 em:
      // WebKit starts a longer word (a URL) on a line of its own when " ·" is glued to it (+328 lines over 199 replies,
      // breaks inside words 60 → 427), and a word that fills its line alone takes the line break at the span's start,
      // the span's space drawn there (8 emoji · at 208 px, text size 130 %)
      let word = at;
      while (word > 0 && at - word < GLUE_MAX && !/\s/.test(text[word - 1])) word--;
      const own = word < at && (word === 0 || /\s/.test(text[word - 1])); // a whole word of 16 characters at most
      // a word at the text's start goes on in `before` when that ends on a character (no box at the start): with the
      // word `before` ends on ("**3,000엔**부터 ·"), and not at all when that is longer
      const head = Math.max(word, box);
      const ext = head === 0 && box !== 0 && afterChar ? lead : "";
      const fit =
        (ext || !afterChar || head > 0 || box === 0) &&
        at + 2 - head + ext.length <= GLUE_MAX &&
        glueEm(ext + text.slice(head, at + 2)) <= GLUE_EM;
      if ((at > last || at === glueEnd) && own && fit) end = at + 2;
      // at the text's start, on the word `before` ends on ("**구름 클리닉** · 8,000엔")
      else if (at === 0 && lead && lead.length + 2 <= GLUE_MAX && glueEm(`${lead} ·`) <= GLUE_EM) end = 2;
    } else if (m[0] === "·") {
      // a "·" inside a word ("전화·카카오톡"): Chrome breaks before it, WebKit never. With the character before it
      // (its whole grapheme cluster, "👍🏻·", "🇰🇷·"; the whole number for a digit: a number is never cut) or the glued
      // run ending there, and a break box after it when a character follows (`breakAfter`): the break after "·" stays,
      // which WebKit drops at a nowrap span's end ("전화·카카 / 오톡" without the box). Plain after a closing mark left
      // plain (no span opens on a closer)
      const prev = prevAt(at);
      if (at === glueEnd) end = at + 1;
      else if (!BREAK_END.test(prev) && !/[)）」』】〕”’]/u.test(prev)) {
        from = at - prev.length;
        if (/\d/.test(prev))
          while (
            from > last &&
            at - from <= GLUE_MAX &&
            (/\d/.test(text[from - 1]) ||
              (/[.,:/–-]/.test(text[from - 1]) && from - 2 >= last && /\d/.test(text[from - 2])))
          )
            from--;
        end = at + 1;
      }
    } else {
      // a closing bracket, "。" or "、": what it closes on, the glued run ending there or the character before it (a
      // whole number when that is a digit: a number is never cut), and for a bracket the mark or letter right after
      // it, left out when the run would grow too long with it. A span never opens on the bracket after a character
      // (both engines break at a nowrap span's start, "W / )W" measured): when what it closes on does not fit, it
      // stays plain, and so does one right after a closing mark left plain ("가」」…」" past the cap) or at the text's
      // start (a run of its own after a link: "carry-in/ / )." with "[).]" glued)
      if (at === 0 || (at > last && (BREAK_END.test(text[at - 1]) || /[”’]/.test(text[at - 1])))) {
        // a closing mark at the start or after one left plain: plain too
      } else {
        if (at > last && !/\s/.test(text[at - 1])) {
          from = at - (at >= 2 && /[\udc00-\udfff]/.test(text[at - 1]) ? 2 : 1);
          if (/\d/.test(text[at - 1]))
            while (from > last && at - from <= GLUE_MAX && (/\d/.test(text[from - 1]) || (/[.,:/–-]/.test(text[from - 1]) && from - 2 >= last && /\d/.test(text[from - 2]))))
              from--;
        }
        const held = from < at || at === glueEnd;
        // "。" and "、" hold on to what comes before them only: a break after them is a sentence's or a clause's
        const after = at + 1 < text.length && AFTER_CLOSE.test(String.fromCodePoint(text.codePointAt(at + 1)!));
        if (after && !/[。、]/.test(m[0])) {
          end = at + 1 + step(at + 1);
          if (held && !fits(from === glueEnd ? runStart : from, end)) end = at + 1;
        } else if (held) end = at + 1;
      }
    }
    // no edge inside a grapheme cluster: the span takes the whole cluster at either end ("(🇰🇷", "👨‍👩‍👧)", "가̂·"),
    // within a glued run's length, or the spot stays plain: a span past 16 characters with a cluster still going on
    // is too long for `fits`. `last` is never inside one, so `from` stops there. Spots take no space or line break, and
    // a surrogate pair is always whole (`step`, `prevAt`)
    if (end > at) {
      while (inside(end) && end - from <= GLUE_MAX) end += step(end);
      while (inside(from) && end - from <= GLUE_MAX) from -= prevAt(from).length;
    }
    // side by side with the run before: one span, unless plain text breaks there or an opener follows a character
    let join = from === glueEnd && !breakAfter() && !cut;
    // too long together: a dash or a number starts a run of its own after a break box (a break before the number,
    // where WebKit would otherwise break inside it); a closer, "。", "、", " ·" and a word's "·" stay plain
    const fresh = join && end > at && !fits(runStart, end) && /^[\d–-]$/u.test(m[0]) && fits(from, end);
    if (fresh) join = false;
    const start = join ? runStart : from;
    if (end > at && fits(start, end) && end <= oddAt) {
      if (join) out.pop();
      else {
        const after = breakAfter();
        if (after) out.push(brk(`b${(box = last)}`));
        if (from > last) out.push(text.slice(last, from));
        if (fresh || (cut && !(after && from === last))) out.push(brk(`w${(box = from)}`));
        spans += 1 + (after ? 1 : 0) + (fresh || (cut && !(after && from === last)) ? 1 : 0);
      }
      out.push({ glue: text.slice(start, end) });
      last = glueEnd = end;
      runStart = start;
      skip = Math.max(skip, end, glueSkip);
    }
    SPOT.lastIndex = skip;
  }
  if (!out.length) return [text];
  if (breakAfter()) out.push(brk(`b${last}`));
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** `gluedPieces` as HTML, each piece escaped on its own */
export function gluedHtml(text: string, before = ""): string {
  return gluedPieces(text, before)
    .map((p) => (typeof p === "string" ? esc(p) : "glue" in p ? `<span class="t-glue">${esc(p.glue)}</span>` : '<span class="t-brk"></span>'))
    .join("");
}
