import { letters, speakable } from "@pickle/protocol";

/**
 * How much of a spoken reply the person heard when they cut it off (barge-in), as text: the call reports it
 * (POST …/heard) so the reply's history keeps only that. Pure, unit-tested in qa/call-heard.test.ts.
 * A reply is spoken as spans, in order: each stream request or sentence (server voice, with the audio pieces scheduled
 * for it on the call's AudioContext clock) or Web Speech chunk. Spans played to the end count whole; the one playing
 * counts by the share of its audio that played, in whole words, rounded down. Its length is the audio it got once all
 * of it arrived, else a guess from its letters (SEC_PER_LETTER) when that is longer. Web Speech has no clock: a chunk
 * counts once it was said whole.
 */
export interface HeardSpan {
  /** the speech text of the request or chunk */
  text: string;
  /** audio scheduled for it: start and duration (s) on the AudioContext clock */
  pieces: { at: number; dur: number }[];
  /** all of its audio arrived */
  complete: boolean;
  /** a Web Speech chunk: counts once `said` */
  web?: boolean;
  said?: boolean;
}

/** about how long Korean speech takes per letter (Drama-3 and the browsers' ko-KR voices: 5–7 letters a second) */
export const SEC_PER_LETTER = 0.17;

/** the longest run of whole words from the start of `text` with at most `n` letters */
export function heardWords(text: string, n: number): string {
  let out = "";
  for (const w of text.split(/\s+/)) {
    if (!w) continue;
    const next = out ? `${out} ${w}` : w;
    if (letters(next) > n) break;
    out = next;
  }
  return out;
}

/** what was heard of the spans at `now` (the AudioContext's currentTime), as speakable text */
export function heardText(spans: readonly HeardSpan[], now: number): string {
  const out: string[] = [];
  for (const s of spans) {
    if (s.web) {
      if (!s.said) break;
      out.push(s.text);
      continue;
    }
    const got = s.pieces.reduce((a, p) => a + p.dur, 0);
    const played = s.pieces.reduce((a, p) => a + Math.max(0, Math.min(p.dur, now - p.at)), 0);
    const total = s.complete ? got : Math.max(got, letters(s.text) * SEC_PER_LETTER);
    if (total > 0 && played >= total - 0.02) {
      out.push(s.text);
      continue;
    }
    const part = total > 0 ? heardWords(s.text, Math.floor((letters(s.text) * played) / total)) : "";
    if (part) out.push(part);
    break;
  }
  return speakable(out.join(" "));
}
