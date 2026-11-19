/**
 * Turn-taking in Korean speech: has the speaker finished their line? Shared by the meeting bot's turn-taking
 * (apps/server/src/meet.ts) and the app's voice call (apps/mobile …/call: an unfinished line waits for the rest, and
 * the reply's first spoken chunk may end at a clause boundary). Pure, no dependencies.
 */

const finalOf = (syllable: string) => {
  const c = syllable.charCodeAt(0) - 0xac00;
  return c >= 0 && c <= 11171 ? c % 28 : -1;
};

/** a filler or adverb that leaves the line hanging ("모시야 그…", "모시야 혹시", "…그리고") */
const OPEN_WORDS = new Set("그 저 음 음음 어 어어 좀 혹시 그리고 근데 그런데 그래서 그러니까 그니까 그러면 그럼 아니면 저기 이제 일단 막 그게".split(" "));
/**
 * Nouns that only look like a word plus a particle or connective ("최고", "결과", "회의", "보고서"…). Only endings that
 * rarely close a noun phrase in a meeting: "오전과", "다음 주의", "사실이라면", "결과로" stay unfinished.
 */
const NOT_OPEN =
  /(?:최고|광고|참고|재고|창고|원고|경고|신고|공고|잔고|금고|(?:문|순|부|도|독|비|엽|고|약|적|청|구|명|획|안|세|증|찰|방)서|(?:화|냉|측|표|정|전|국|방|단|지|대|장)면|(?:회|논|합|협|동|강|토)의|(?:경|진|통|미|항)로|(?:결|성|통|학)과|(?:온|속|각|태|강|습|밀|농|제|용|진|한|빈|난|의|인|포)도|(?:잠깐|잠시|그|이|백|천|십|억|수)만|(?:휴|평|고|저|여|외|호|추|특)가|같이|많이|깊이|높이|길이|넓이|굳이|없이|고양이|종이|놀이|사랑|마을|가을|노을)$/;

/** -지만, -거나, -든지, -니까, -면서, -고, -서, -면, -는데 / -은데 / -ㄴ데 (word: letters only, NOT_OPEN already ruled out) */
function connective(word: string, chars: string[]): boolean {
  if (/(?:지만|거나|든지|든가|니까|니깐|면서)$/.test(word)) return true;
  const last = chars[chars.length - 1]!;
  const prev = chars[chars.length - 2]!;
  if (last === "고" || last === "서" || last === "면") return true;
  return last === "데" && (prev === "는" || prev === "은" || finalOf(prev) === 4);
}

/**
 * The word (letters only) ends in a connective ending: the clause goes on ("확인하고", "좋긴 한데", "급하진 않지만").
 * Fillers and adverbs ("그리고", "그래서") are not connectives; nouns that only look like one ("최고", "보고서",
 * "화면") are not either.
 */
export function endsInConnective(word: string): boolean {
  const chars = [...word];
  if (chars.length < 2 || OPEN_WORDS.has(word) || NOT_OPEN.test(word)) return false;
  return connective(word, chars);
}

/**
 * The speaker isn't done yet: the line ends in a connective (-고, -는데, -서, -면, -면서, -지만, -거나, -든지, -니까), a
 * dangling particle (를/을, 이/가, 은/는, 에/에서, 의, 로/으로, 랑/하고/와/과, 도, 만), a filler or adverb (그, 음, 좀,
 * 혹시, 그리고, 근데, 그래서, 그러니까), a comma or "…". A question mark makes any line complete ("그럼 내일은?").
 * A heuristic on the last word only: a false "unfinished" costs one hold (the meeting's turnHoldMs, the call's
 * hold), a false "finished" an early answer.
 */
export function turnIncomplete(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(?:[,，、]|…|\.{2,})\s*$/.test(t)) return true;
  if (/[?？]\s*$/.test(t)) return false;
  const words = t.replace(/[\s.!。！~]+$/u, "").split(/\s+/);
  const word = (words[words.length - 1] ?? "").replace(/[^\p{L}\p{N}]/gu, "");
  if (!word) return false;
  if (OPEN_WORDS.has(word)) return true;
  const chars = [...word];
  if (chars.length < 2 || NOT_OPEN.test(word)) return false;
  if (connective(word, chars)) return true;
  const last = chars[chars.length - 1]!;
  const prev = chars[chars.length - 2]!;
  // particles
  if ("를을은는에의로랑와과도만".includes(last)) return true;
  if (last === "이") return finalOf(prev) > 0; // 매출이 — not 차이, 사이
  if (last === "가") return finalOf(prev) === 0; // 회의가 — not 건가, 인가 (questions)
  return false;
}
