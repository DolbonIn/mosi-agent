import { Fragment, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import "./Text.css";

/**
 * Korean copy that breaks well (FOUNDATION.md › Line breaks). The element holding the copy takes `.t-copy`
 * (text-wrap: pretty: no one-word last line), and the text goes through `Sentences`:
 *   - each sentence of a text of two or more is an inline-block (`.t-s`, pretty inside too), so a short sentence never
 *     starts at the end of a line and wraps mid-way ("…주문을 봐요. 주문은 / 넣지 않아요."): it moves down whole, or
 *     sits beside the one before when both fit. A sentence longer than the line still wraps inside itself.
 *   - tight spots are tied (`.t-tie`, an inline-block: one line while it fits one, wrapping inside only when wider
 *     than the whole line). A word is cut after each "·" and before a "(" that follows Hangul (a Latin letter or
 *     digit keeps it: "presentSheet()"); the pieces holding "(", "·" or a ")" with
 *     more after it are tied, and a <wbr> sits between pieces: "공연<wbr>(연극·<wbr>뮤지컬·<wbr>콘서트)을". So a line may end
 *     after "·" or before "(", but never on "(" and never starts with ")" or "·" — WebKit's text-wrap: pretty picks
 *     both, and a nbsp alone does not stop it. The <wbr> adds no break: a box's edges are breaks already (the same
 *     lines without it, 22,179 blocks in both engines); it is from when ties were nowrap inlines, between which WebKit
 *     never breaks (an empty box there moves WebKit's pretty in 184 of 6,204 blocks). A box, not an inline: with four
 *     nowrap inlines in a line WebKit's pretty laid "찾아" on two lines at once (drawn twice) and left "알려줘요." alone
 *     (k_place_search, 263 px); as boxes it is two clean lines. A box takes no underline from its parent, so tied copy
 *     does not go inside a link.
 *   - a "·" standing between spaces ("01*** · 3일 전") rides on the word before it over a nbsp: the dot ends its line.
 *     After a line break ("준비물\n· 물") it opens its line and stays, and in a line-clamped slot it stays apart when
 *     the word and the dot would not fit the clamp: a line may then start with "·", but the word keeps its tie
 *     ("쿠팡 · 132,400원 · …" beside 실행 취소, 5 em; with the dot on, "132,400원 ·" was too wide to tie and WebKit split
 *     "132, / 400원").
 *   - a word holding a quote or corner bracket with letters on its inner side is tied: "“내", "줘”처럼", "‘테스트’예요".
 *     Under keep-all both engines still break between ” ’ and the Hangul after it ("기억해 줘” / 처럼 말하면", the
 *     AgentScreen footer at W320), and WebKit between “ ‘ and the Hangul after it ("없어요. “ / 내 생일은"): UAX #14 LB19a
 *     lets East Asian letters break around a quote.
 *   - a number and the unit or counter after it ride together over a nbsp, tied: "3.3만 원", "회비 3만 원은", "10 km를"
 *     (the space keep-all breaks at: "3만 / 원은", the room card at W430). The unit's word may only go on with a particle
 *     or punctuation ("원이에요", "곳을", "km,"), so "1 일정" or "3 대학로" stay apart; a run longer than 16 characters
 *     is left alone.
 *   - a piece holding a number with a separator inside, or a number with % ° ℃ and letters after it, is tied (16
 *     characters at most): "3.3만", "1,200,000원이고", "12:30에", "11:39–11:51", "1/2이고", "2026-11-17이고", "3%이고".
 *     Under keep-all WebKit breaks at the point, comma, colon, slash and en dash ("최대 3. / 3만 원이"), Chrome after a
 *     hyphen or en dash and between % and the Hangul after it ("3.3% / 이고"), both with room on the line for the word.
 *   - one-syllable words ride over a nbsp, tied, on the word they belong to (16 characters at most), so none is left
 *     alone at a line's end or start:
 *       forward: a determiner standing alone and the next word ("한 번", "새 메시지", "총 23곳"; "네," with a comma is
 *       an answer and stays), a period noun and the amount after it ("월 최대", "연 4.5%", "주 3회", "일 단위"; "주
 *       정부" and "일 처리" stay apart), an area noun and "단위" ("구 단위까지만");
 *       back: an auxiliary verb on the -아/-어 form before it ("예약해 둔", "적어 줘", "써 볼"; "할 줄" stays apart).
 *   - a word holding a domain is tied whole, path, particle and all, at any length: "microsoft.com/devicelogin에",
 *     "example.co.kr", "user@example.com". WebKit breaks inside it at "." and "/" ("microsoft. / com/devicelogin에");
 *     a box wider than the line wraps inside instead of running out.
 * No tie is wider than its line where the slot says how narrow its lines get. A box wider than the line wraps inside: it
 * takes the line whole, so what follows goes down a line, and a nbsp at its break is drawn at the next line's start
 * ("고성군문화복지센터&nbsp; / · 강원", the dot 3–4 px in, three lines for two). A slot that can be narrower than its ties
 * gives its narrowest line in em at the width at hand (`copy(text, { line })`, a results row's subtitle beside its time,
 * from its list's width by `useWidth`): with the narrowest phone's line at every width, a tie that fits a wider line
 * comes apart there too ("보내줘” / 라고 입력했다." at 430, "·" opening lines). A line-clamped one gives it as `clamp`
 * (`copy(text, { clamp: 5 })`, the banner body): -webkit-line-clamp counts a box that wraps inside as one line, so a
 * 2-line clamp would show 3.
 * In a narrow cell the copy wraps plainly: a `.t-cell` (a container; ListRow's text column) under 160 px turns pretty and
 * the sentence blocks off, since in a narrow column they only add lines. The ties stay at every width.
 * Not straight into a flex container: each sentence span would be a flex item of its own. Wrap the copy in a span
 * there (TextField's error sits in ContentSwap's span; kakao-chat's Note wrapper does the same).
 * From kakao-chat's Sentences / TiedLine (SkillAccounts.tsx, skill-ui-12 → 24). The check is qa/lib/lines.mjs.
 */

/** a text's sentences: split after ". ", "! " and "? " */
export const sentencesOf = (text: string): string[] => text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);

// after each "·"; before "(" unless a Latin letter or digit holds it ("presentSheet()", "f(x)": no break there to keep)
const PIECE = /(?<=·)(?=.)|(?<![A-Za-z0-9])(?=\()/u;
// a word ending in a number ("3", "3.3만", "1,200"), and a unit or counter word after it
const NUM_END = /\d(?:[.,]\d+)*[만천억조]?$/;
const UNIT =
  /^(?:원|달러|엔|위안|유로|개월|개|명|곳|건|번|회|차|분|초|시간|일|주|년|살|세|층|호|장|권|잔|병|대|마리|점|평|배|인분|인|박|가지|단계|줄|쪽|km|cm|mm|m|kg|g|L|ml|KB|MB|GB|TB|%|℃|도)(?=$|[^\p{L}]|(?:은|는|이|가|을|를|에서|에게|에는|에도|에|의|도|와|과|로|으로|만|까지|부터|씩|쯤|짜리|째|예요|이에요|입니다|이고|이나|이면|이라|당|간|가량|여|정도|마다|보다|처럼|밖에|뿐)(?:$|[^\p{L}]))/u;
// a one-syllable determiner standing alone ("한 번", "새 메시지", "총 23곳"; "네," with its comma is an answer, not one),
// and the word after it
const DET = /^(?:이|그|저|새|헌|각|몇|온|총|약|한|두|세|네|첫)$/;
const DET_NEXT = /^[\p{L}\p{N}]/u;
// a one-syllable period noun and the amount after it ("월 최대", "연 4.5%", "주 3회", "일 단위"; not "주 정부", "일 처리"),
// or an area noun and "단위" ("구 단위까지만")
const PER = /^(?:월|연|년|주|일|회)$/;
const PER_NEXT = /^(?:최대|최소|최고|평균|단위|(?:약|총)(?!\p{L})|\d)/u;
const AREA = /^(?:시|군|구|동|읍|면)$/;
const AREA_NEXT = /^단위/;
// a one-syllable auxiliary verb after the -아/-어 form it leans on ("예약해 둔", "적어 줘", "써 볼"; "할 줄" is no -아/-어).
// The form is read on the decomposed word (NFD): its last syllable ends in ㅏ ㅓ ㅕ ㅐ ㅘ ㅝ ㅙ with no final consonant,
// which holds 아 어 여 해 워 와 and the short forms (써, 가, 봐, 줘, 돼, 켜)
const AUX_PREV = /[\u1161\u1165\u1167\u1162\u116a\u116f\u116b]$/u;
const AUX = /^(?:둔|둘|둬|뒀|준|줄|줘|줬|본|볼|봐|봤)(?![\p{L}\p{N}])/u;
// a number with a separator inside ("3.3", "1,200", "12:30", "1/2", "11–16", "2026-11-17"), or with % ° ℃ and letters
// after it ("3%이고")
const NUM_IN = /\d[.,:/–-]\d|\d[%‰°℃]\p{L}/u;
// a domain: a letter or digit, a point, two Latin letters or more ("microsoft.com", "example.co.kr", "user@example.com");
// the word holding it, path and particle too ("microsoft.com/devicelogin에"), is tied at any length
const URL_IN = /[\p{L}\p{N}]\.[A-Za-z]{2,}/u;
const tight = (piece: string) =>
  /[(·\u00a0]/.test(piece) || /[)”’」』]\S|[“‘「『]\S/.test(piece) || (NUM_IN.test(piece) && piece.length <= 16) || URL_IN.test(piece);
// a character's width in em, never under the system font's: the app's --font-text at every size it draws text at
// (the type tokens 13–34 px × text size 0.9–1.3: 11.7–44.2 px), letter spacing 0, both engines, the widest; every
// assigned code point of the BMP and plane 1 and every 7th of planes 2–3 (the widest of each group in brackets). Marks
// and format characters draw on the character before them and count 0. The first group that holds it counts
const EM: [RegExp, number][] = [
  [/\u20e3/u, 1], // a keycap's frame: "1️⃣" 1.47 = "1" 0.48 + 1
  // marks, the emoji style selector, joiners (not the signs that span the digits after them)
  [/(?![\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u{110bd}\u{110cd}])[\p{Mn}\p{Me}\p{Cf}]/u, 0],
  // Hangul, kana, Han, CJK punctuation, letters and symbols ("ㅋㅋ", "㈜", "㎏") and full-width forms (0.99; wide on
  // purpose: Hangul is 0.87 here and near 1 in other fonts); before them old jamo, compatibility squares and ideographs
  // and five brackets and marks (1.02: "ㆼ", "〚")
  [/[\u1100-\u11ff\u301a\u301b\u3031\u3032\u3037\u3190-\u33ff\ua960-\ua97f\ud7b0-\ud7ff\uf900-\ufaff]/u, 1.03],
  [/[\u3000-\u302d\u3030-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uff00-\uffef]/u, 1],
  // ASCII and Latin-1 are in LATIN (below); the punctuation past them that copy uses, on steps (the widest of each)
  [/[\t\n\r‘’‚‛]/u, 0.32], // (0.30)
  [/[“”„‟•‣․‧‖‗‐‑]/u, 0.48], // (0.48)
  [/[†‡]/u, 0.56], // (0.52)
  [/–/u, 0.63], // (0.59)
  [/[…—]/u, 0.88], // (0.88)
  [/[←↑→↓₩]/u, 0.97], // (0.92)
  [/[\x00-\xff]/u, 0.67], // control characters
  // emoji, other Latin, Greek and Cyrillic letters, the widest other symbols (1.47: "😀", "ᾯ")
  [/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/u, 1.5],
  [/[\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}‰‱⩶⬷\u{1f747}⛟\u{1f76b}⬤⬲⮐⮑⒛]/u, 1.5],
  // other symbols and spaces ("℃" 1.19, "★" 1.03, "①" 0.94)
  [/(?![⸺⸻⬳⨌\u{10198}])[\p{sc=Common}\p{sc=Inherited}]/u, 1.2],
];
// ASCII (U+0020–U+007E) and Latin-1 (U+00A0–U+00FF), each character's own width in thousandths of an em: the widest
// drawn over the app's sizes and both engines (as EM), rounded up; the soft hyphen 0. A table, not steps: by steps a
// Latin word counted 6.6 % over its drawn width (the median of 5,662 strings), so a domain that fits its line came
// apart ("w-clinic-w-eygpq.hatenablog.com ·" 16.47 em drawn, 17.96 by steps, at a 17.04 em line)
const LATIN = (
  "284 314 480 632 632 929 715 300 385 385 475 632 300 475 300 308 632 467 607 630 647 621 640 572 642 640 300 300 " +
  "632 632 632 516 921 676 660 719 730 599 575 750 746 270 541 662 571 877 746 775 638 775 656 640 636 740 676 970 " +
  "682 658 664 385 308 385 632 587 514 555 617 563 617 575 365 612 591 250 249 545 256 873 587 593 613 612 384 527 " +
  "366 587 545 778 527 545 541 385 262 385 632 284 314 632 632 632 632 262 600 514 897 393 664 632 0 696 514 475 " +
  "632 344 357 514 617 600 300 514 265 421 664 783 816 881 516 676 676 676 676 676 676 963 719 599 599 599 599 270 " +
  "270 270 270 759 746 775 775 775 775 775 632 771 740 740 740 740 658 628 625 555 555 555 555 555 555 906 563 575 " +
  "575 575 575 250 250 250 250 585 587 593 593 593 593 593 632 593 587 587 587 587 545 613 545"
)
  .split(" ")
  .map((n) => Number(n) / 1000);
// the pairs whose kerning widens them, of those characters and the punctuation on steps below (348 of 46,656; most
// narrow or keep them), by how much in thousandths of an em, the most over the app's sizes and both engines: added to
// the first of the two, so a string is never counted under its drawn width ("_j" 79, "r’" 64, "Tì" 59; "rt" drawn
// 0.759, 0.750 by its characters)
const KERN = new Map<string, number>(
  ([
    [79, "_j"],
    [64, "r’ r”"],
    [59, "Tì Tî Tï íT îT ïT"],
    [54, "Vì Vî Vï íV îV ïV"],
    [45, "r² r³ r¹ µ² µ³ µ¹"],
    [40, ",/ ./ Wì Wî Wï \\, \\. \\… íW îW ïW …/"],
    [35, "*Ð Fì Fî Fï T² T³ T¹ ^Ð °Ð ²T ²t ³T ³t ¹T ¹t ’² ’³ ’¹ ”² ”³ ”¹"],
    [31, "r“"],
    [
      30,
      "(j 0\\ 9\\ BÐ P‘ P“ V² V³ V¹ W² W³ W¹ X² X³ X¹ Y² Y³ Y¹ [j \\j f² f³ f¹ g_ q_ rf r‘ {j ²B ²D ²E ²F ²H ²I " +
      "²K ²L ²M ²N ²P ²R ²V ²W ²X ²Y ²È ²É ²Ê ²Ë ²Ì ²Í ²Î ²Ï ²Ñ ²Ý ²Þ ³B ³D ³E ³F ³H ³I ³K ³L ³M ³N ³P ³R ³V ³W " +
      "³X ³Y ³È ³É ³Ê ³Ë ³Ì ³Í ³Î ³Ï ³Ñ ³Ý ³Þ µ’ µ” ¹B ¹D ¹E ¹F ¹H ¹I ¹K ¹L ¹M ¹N ¹P ¹R ¹V ¹W ¹X ¹Y ¹È ¹É ¹Ê ¹Ë " +
      "¹Ì ¹Í ¹Î ¹Ï ¹Ñ ¹Ý ¹Þ Ý² Ý³ Ý¹",
    ],
    [26, "——"],
    [
      25,
      "&B &D &E &F &H &I &K &L &M &N &P &R &È &É &Ê &Ë &Ì &Í &Î &Ï &Ñ &Þ E² E³ E¹ F² F³ F¹ Pf Pt Rt rt È² È³ È¹ " +
      "É² É³ É¹ Ê² Ê³ Ê¹ Ë² Ë³ Ë¹",
    ],
    [21, "77 7\\ Pv Py Pý Pÿ T\\ W\\ dì f’ t’ xf"],
    [
      20,
      "&A &À &Á &Â &Ã &Ä &Å E\\ H\\ I\\ J\\ M\\ N\\ U\\ V\\ _v _y _ý cf f” lì r? t” ·Ð È\\ É\\ Ê\\ Ë\\ Ì\\ Í\\ " +
      "Î\\ Ï\\ Ñ\\ Ù\\ Ú\\ Û\\ Ü\\ çf",
    ],
    [16, "3\\ 5\\ 6\\ 8\\ C\\ Y\\ fY fÝ uf Ç\\ Ý\\ ùf úf ûf üf"],
    [15, "&J /T P\\ rv ry rý"],
    [11, ",5 ,9 .5 .9 F\\ Rf X\\ _p ct rm rn rp rr rñ çt …5 …9"],
    [
      6,
      ":2 ;2 ’B ’D ’E ’F ’H ’I ’K ’L ’M ’N ’P ’R ’È ’É ’Ê ’Ë ’Ì ’Í ’Î ’Ï ’Ñ ’Þ ”B ”D ”E ”F ”H ”I ”K ”L ”M ”N ”P " +
      "”R ”È ”É ”Ê ”Ë ”Ì ”Í ”Î ”Ï ”Ñ ”Þ",
    ],
  ] as [number, string][]).flatMap(([n, ps]) => ps.split(" ").map((p): [string, number] => [p, n / 1000])),
);
const PICT = /\p{Extended_Pictographic}/u;
const emSeen = new Map<string, number>(); // a character's group, found once
const latinEm = (cp: number) =>
  cp >= 0x20 && cp < 0x7f ? LATIN[cp - 0x20] : cp >= 0xa0 && cp <= 0xff ? LATIN[cp - 0xa0 + 95] : undefined;
const emOf = (c: string) =>
  emSeen.get(c) ?? emSeen.set(c, latinEm(c.codePointAt(0) ?? 0) ?? EM.find(([r]) => r.test(c))?.[1] ?? 4.7).get(c)!;
/**
 * a text's width in em, never under the system font's (`EM` above; anything else, other scripts and the five widest
 * symbols, 4.7: "𒐫" 4.64): a skin tone after an emoji and an emoji joined to the one before it (ZWJ) are drawn inside
 * it and add nothing ("👍🏻", "👩‍💻" 1.5)
 */
export const emWidth = (s: string): number =>
  [...s].reduce(
    (n, c, i, a) =>
      n +
      ((/\p{Emoji_Modifier}/u.test(c) && PICT.test(a[i - 1] ?? "")) || (a[i - 1] === "\u200d" && PICT.test(c))
        ? 0
        : emOf(c) + (KERN.get(c + (a[i + 1] ?? "")) ?? 0)),
    0,
  );

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
const odd = (s: string) => oddFrom(s, 0) >= 0;

/** `limit`: the widest tie, in em (a line-clamped slot's narrowest line; Infinity elsewhere) */
function tiedWord(word: string, key: number, limit: number): ReactNode {
  const tie = (p: string) => tight(p) && (limit === Infinity || emWidth(p) <= limit);
  const pieces = word.split(PIECE).filter(Boolean);
  if (!pieces.some(tie)) return <Fragment key={key}>{word}</Fragment>;
  return (
    <Fragment key={key}>
      {pieces.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? <wbr /> : null}
          {tie(p) ? <span className="t-tie">{p}</span> : p}
        </Fragment>
      ))}
    </Fragment>
  );
}

/** does word `w` ride on the word before it over a nbsp (`prev` may hold riders already: its last part decides) */
function rides(prev: string, w: string): boolean {
  const end = prev.split("\u00a0").pop() ?? prev;
  return (
    (NUM_END.test(prev) && UNIT.test(w)) ||
    (DET.test(end) && DET_NEXT.test(w)) ||
    (PER.test(end) && PER_NEXT.test(w)) ||
    (AREA.test(end) && AREA_NEXT.test(w)) ||
    (AUX_PREV.test(prev.normalize("NFD")) && AUX.test(w))
  );
}

/**
 * the text with its tight spots tied (see above). `clamp`: the slot's narrowest line in em (a line-clamped slot's, or
 * a narrow one's: `copy(text, { line })`); no tie or nbsp run is wider (a box wider than the line wraps inside, takes
 * the line whole and, line-clamped, counts as one line). Past it a "·" stays apart and the word keeps its own tie
 */
export function tied(text: string, { clamp = Infinity }: { clamp?: number } = {}): ReactNode {
  const words: string[] = [];
  for (const w of text.split(/(\s+)/).filter(Boolean)) {
    const last = words.length - 1;
    // over spaces and nbsp only: a "·" opening a line of its own ("준비물\n· 물") stays there; in a clamp only while
    // the word and its dot fit, so the dot never unties the word ("132,400원" 4.85 em, "132,400원 ·" 5.45 em)
    if (
      w === "·" &&
      last >= 1 &&
      /^[ \u00a0]+$/.test(words[last]) &&
      !/^\s+$/.test(words[last - 1]) &&
      (clamp === Infinity || emWidth(`${words[last - 1]} ·`) <= clamp)
    ) {
      words.pop();
      words[last - 1] = `${words[last - 1]}\u00a0·`;
    } else if (
      last >= 1 &&
      /^[ \u00a0]+$/.test(words[last]) &&
      words[last - 1].length + 1 + w.length <= 16 &&
      (clamp === Infinity || emWidth(`${words[last - 1]} ${w}`) <= clamp) &&
      rides(words[last - 1], w)
    ) {
      words.pop();
      words[last - 1] = `${words[last - 1]}\u00a0${w}`;
    } else words.push(w);
  }
  // from a word holding a character WebKit sizes apart from how it draws it (`ODD`) to the line's end ("\n"), no tie:
  // a box there would move what follows it on the line
  let off = false;
  return words.map((w, i) => {
    if (/^\s+$/.test(w)) {
      if (w.includes("\n")) off = false;
      return <Fragment key={i}>{w}</Fragment>;
    }
    off ||= odd(w);
    return off ? <Fragment key={i}>{w}</Fragment> : tiedWord(w, i, clamp);
  });
}

/**
 * a text that breaks only between its sentences, with its tight spots tied (`sentences={false}`: ties only; `clamp`:
 * a line-clamped slot's narrowest line in em, ties only and none wider; `line`: a narrow slot's narrowest line in em,
 * no tie wider)
 */
export function Sentences({
  text,
  sentences = true,
  clamp,
  line,
}: {
  text: string;
  sentences?: boolean;
  clamp?: number;
  line?: number;
}) {
  // no sentence blocks in a text holding a character WebKit sizes apart from how it draws it (`ODD`): its block would
  // move the sentence after it
  const parts = sentences && clamp === undefined && !odd(text) ? sentencesOf(text) : [];
  const widest = clamp ?? line;
  if (parts.length < 2) return <>{tied(text, { clamp: widest })}</>;
  return (
    <>
      {parts.map((s, i) => (
        <Fragment key={i}>
          {i > 0 ? " " : null}
          <span className="t-s">{tied(s, { clamp: widest })}</span>
        </Fragment>
      ))}
    </>
  );
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
const brk = (key: string) => <span key={key} className="t-brk" />;

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
export function glued(text: string, before = ""): ReactNode {
  const out: ReactNode[] = [];
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
      out.push(
        <span key={start} className="t-glue">
          {text.slice(start, end)}
        </span>,
      );
      last = glueEnd = end;
      runStart = start;
      skip = Math.max(skip, end, glueSkip);
    }
    SPOT.lastIndex = skip;
  }
  if (!out.length) return text;
  if (breakAfter()) out.push(brk(`b${last}`));
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * A copy slot's content: a plain string goes through `Sentences`; anything else (a node the caller built) is left as
 * it is. `clamp` for a line-clamped slot, its narrowest line in em (the banner body: `{ clamp: 5 }` beside 실행 취소):
 * no sentence blocks (an inline-block sentence would be one tall line to the clamp) and no tie wider (a box wider than
 * the line wraps inside and shows a line more). `line` for a slot that can be narrower than its ties, its narrowest
 * line in em at the width at hand (a results row's subtitle beside its time, from `useWidth`): no tie wider (a box
 * wider than the line wraps inside and takes the line whole, its nbsp drawn at the next line's start), the sentence
 * blocks kept.
 * `sentences: false` turns the sentence blocks off alone.
 */
export function copy(
  node: ReactNode,
  { sentences = true, clamp, line }: { sentences?: boolean; clamp?: number; line?: number } = {},
): ReactNode {
  return typeof node === "string" ? <Sentences text={node} sentences={sentences} clamp={clamp} line={line} /> : node;
}

/**
 * The layout width in px of `ref`'s element (a transform does not change it), read before the first paint and again
 * on every resize; `fallback` until then (a server render, a test) and while the element draws nothing. For
 * `copy(text, { line })` in a slot whose lines follow the viewport: the line at hand, not the narrowest phone's.
 */
export function useWidth(ref: RefObject<Element | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return width;
}
