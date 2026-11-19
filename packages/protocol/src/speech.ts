/**
 * The text a reply is spoken as. Shared by the app's voice call (apps/mobile …/call/speechText.ts: subtitles, the TTS
 * cuts, how much of a reply was heard) and the server (apps/server/src/history.ts cutToHeard: a barged-in reply is kept
 * in history only up to what was heard), so both count the same letters. Pure, no dependencies.
 */

const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*️?/gu;
const EMOJI_GAP = new RegExp(`${EMOJI.source}[ \\t]+`, "gu");

/** markdown, links and emoji out; line breaks kept (they end a sentence) */
export function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>)]+>?/g, "")
    .replace(/^[ \t]*(?:#{1,6}|>|[-*•+])[ \t]+/gm, "")
    // "1. 서울역": the list number stays, its dot must not end a sentence
    .replace(/^([ \t]*\d{1,2})[.)][ \t]+/gm, "$1 ")
    .replace(/[*_`#>|]+/g, "")
    // an emoji before a space usually closes a sentence ("깽이예요 😊 오늘은…")
    .replace(EMOJI_GAP, "\n")
    .replace(EMOJI, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t ]+/g, " ");
}

/** the spoken line: markdown, URLs and emoji stripped, whitespace collapsed (the call's subtitle) */
export function speakable(text: string): string {
  return forSpeech(text).replace(/\s+/g, " ").trim();
}

/** letters and digits: how speech is measured (spacing and punctuation settle late, letters don't) */
export function letters(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/** letters and digits only, lower-cased: two spoken texts compared regardless of spacing and punctuation */
export function speechNorm(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}
