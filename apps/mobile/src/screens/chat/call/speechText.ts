import { endsInConnective, forSpeech, letters, speakable, speechNorm } from "@pickle/protocol";

export { letters, speakable };

/**
 * Text for the voice: what the call says aloud and shows as subtitles. Pure (no DOM), unit-tested in qa/chat-speech.test.ts.
 *   speakable(text)     markdown, URLs and emoji stripped, whitespace collapsed (the subtitle line; from @pickle/protocol,
 *                       which the server's heard cut counts with too)
 *   streamSegments(text) the text for /api/tts/stream: whole sentences (each closed with punctuation, so a line break or
 *                       an emoji still ends one) in as few ≤ 600-character requests as possible — normally exactly one
 *   packSegments(pieces) pieces the call already cut (speechCutter) packed the same way: in order, ≤ 600 characters
 *   speechChunks(text)  the same text cut into sentences for /api/tts: a short first chunk (time to first audio),
 *                       long sentences broken at a comma or a space, tiny pieces ("네!") joined to the next one.
 *   speechCutter()      the reply spoken WHILE it streams: feed it the growing draft, it hands out each new piece once
 * Generation runs at about real time and each chunk must arrive within 12 s, so a chunk stays under ~70 characters
 * (≈ 8 s of Korean speech).
 */

const FIRST_MAX = 36;
const MAX = 70;
/** a piece with fewer letters than this is joined to the next one */
const TINY = 5;

/** where to cut a too-long sentence: after the last comma in the back part, else at the last space, else hard */
function breakAt(s: string, max: number): number {
  const head = s.slice(0, max + 1);
  const floor = Math.floor(max * 0.35);
  const comma = Math.max(head.lastIndexOf(", "), head.lastIndexOf("，"), head.lastIndexOf("、"));
  if (comma >= floor) return comma + 1;
  const space = head.lastIndexOf(" ");
  if (space >= floor) return space;
  return max;
}

/** a sentence ends at . ! ? … (and closing quotes) followed by a space; "3.5도" and "10~15" stay whole */
const SENTENCE_END = /([.!?…。！？~]+["'”’)\]]*)\s+/g;

/** the sentences of a speech text; `closed`: more text follows it (the last one of an unfinished draft is open) */
function sentenceParts(speech: string, done: boolean): { text: string; closed: boolean }[] {
  const out: { text: string; closed: boolean }[] = [];
  const lines = speech.split(/\n+/);
  lines.forEach((line, li) => {
    const parts = line.replace(SENTENCE_END, "$1\u0000").split("\u0000");
    parts.forEach((part, pi) => {
      const s = part.replace(/\s+/g, " ").trim();
      if (letters(s) > 0) out.push({ text: s, closed: done || li < lines.length - 1 || pi < parts.length - 1 });
    });
  });
  return out;
}

function sentencesOf(text: string): string[] {
  return sentenceParts(forSpeech(text), true).map((p) => p.text);
}

/** the service's limit per request */
export const STREAM_MAX = 600;

/** a sentence sent on its own ends with punctuation (the voice's closing intonation): a line break or an emoji ended it */
const closeSentence = (s: string) => (/[.!?…。！？~,:;]["'”’)\]]*$/.test(s) ? s : `${s}.`);

export function streamSegments(text: string): string[] {
  return packSegments(sentencesOf(text).map(closeSentence));
}

/** pieces to say, in order, in as few ≤ STREAM_MAX requests as possible (a longer piece is broken at a comma or space) */
export function packSegments(pieces: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of pieces) {
    let s = raw.trim();
    if (!s) continue;
    while (s.length > STREAM_MAX) {
      const cut = breakAt(s, STREAM_MAX);
      if (cur) out.push(cur);
      cur = "";
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (cur && cur.length + 1 + s.length > STREAM_MAX) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

export function speechChunks(text: string): string[] {
  const sentences = sentencesOf(text);
  const pieces: string[] = [];
  for (const s of sentences) {
    let rest = s;
    for (let max = pieces.length ? MAX : FIRST_MAX; rest.length > max; max = MAX) {
      const cut = breakAt(rest, max);
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }
  const out: string[] = [];
  let carry = "";
  for (const p of pieces) {
    const joined = carry ? `${carry} ${p}` : p;
    if (carry && joined.length > MAX) {
      out.push(carry);
      carry = p;
    } else carry = joined;
    if (letters(carry) >= TINY) {
      out.push(carry);
      carry = "";
    }
  }
  if (carry) {
    if (out.length && `${out[out.length - 1]} ${carry}`.length <= MAX) out[out.length - 1] += ` ${carry}`;
    else out.push(carry);
  }
  return out;
}

const norm = speechNorm;

/**
 * Barge-in guard: is what the recogniser heard just the agent's own voice coming back through the speaker?
 * Too short to tell (< 2 letters) counts as echo; otherwise it is echo when the spoken text contains it, or when most of
 * its letter pairs occur in the spoken text.
 */
export function isEcho(heard: string, spoken: string): boolean {
  const h = norm(heard);
  if (h.length < 2) return true;
  const ref = norm(spoken);
  if (!ref) return false;
  if (ref.includes(h)) return true;
  const pairs = new Set<string>();
  for (let i = 0; i < ref.length - 1; i++) pairs.add(ref.slice(i, i + 2));
  let n = 0;
  let hit = 0;
  for (let i = 0; i < h.length - 1; i++, n++) if (pairs.has(h.slice(i, i + 2))) hit++;
  return n > 0 && hit / n >= 0.6;
}

// ── the reply spoken while it streams ──

/** a first sentence still open at this many letters is long (≈ 3 s of speech): it may be cut at a clause boundary */
export const CLAUSE_LONG = 24;
/** …that leaves at least this many letters in the first piece (≈ 1.5–2 s of audio: covers the next request's TTFA) */
export const CLAUSE_MIN = 12;
/** endings that look like a connective but close a particle or a quote: no clause boundary after them */
const NOT_CLAUSE = /(?:(?:에|께|에게|한테|부터)서|(?:님|씨)하고|(?:라|다|냐|자)고)$/;

/**
 * The part of a streaming draft whose speech text can't change any more: an open code fence or an open link
 * ("[기상청](https://…" still arriving) holds everything from where it starts.
 */
function settledDraft(raw: string): string {
  let s = raw;
  if ((s.split("```").length - 1) % 2) s = s.slice(0, s.lastIndexOf("```"));
  const open = s.lastIndexOf("[");
  if (open > s.lastIndexOf("]")) return s.slice(0, open);
  const target = s.lastIndexOf("](");
  if (target >= 0 && s.indexOf(")", target) < 0) s = s.slice(0, Math.max(0, s.lastIndexOf("[", target)));
  return s;
}

/** the text after the first `n` letters of `s` (the rest of a sentence whose first clause was said), its lead trimmed */
function afterLetters(s: string, n: number): string {
  let seen = 0;
  let i = 0;
  for (const ch of s) {
    if (seen >= n) break;
    i += ch.length;
    if (/[\p{L}\p{N}]/u.test(ch)) seen++;
  }
  return s.slice(i).replace(/^[\s,，、.!?…~:;]+/u, "");
}

/**
 * Where a long open first sentence may be cut: after its LAST comma or connective ending ("…그치고", "…했는데") that has
 * at least CLAUSE_MIN letters before it and is followed by a space (the next word has begun). Never mid-word, never
 * after a particle ("회의실에서", "하늘 님하고") or a filler ("그리고"). null: no such boundary yet.
 */
function clauseCut(s: string): string | null {
  let count = 0;
  let cut: string | null = null;
  for (const m of s.matchAll(/\S+(?=\s)/g)) {
    const word = m[0];
    count += letters(word);
    if (count < CLAUSE_MIN) continue;
    const bare = word.replace(/[^\p{L}\p{N}]/gu, "");
    if (/[,，、]$/.test(word) || (/[\p{L}\p{N}]$/u.test(word) && endsInConnective(bare) && !NOT_CLAUSE.test(bare))) cut = s.slice(0, m.index + word.length);
  }
  return cut;
}

export interface SpeechCutter {
  /**
   * The reply so far (the raw model text of the streaming draft) → the new pieces to say, in order; each piece of the
   * reply is handed out once. `closed`: no more text follows the draft's end for now (a tool is running, or the turn is
   * over), so its last sentence is whole even without a mark after it. `final`: this is the whole reply (the done
   * message): its exact text, nothing held back.
   */
  feed(draft: string, closed?: boolean, final?: boolean): string[];
  /** everything handed out so far (the echo guard compares against it) */
  said(): string;
  /** the draft stopped starting with what was said: nothing more is handed out (the caller stops the voice) */
  diverged(): boolean;
}

/**
 * Only whole sentences leave: a sentence is whole once whitespace follows its end mark (". " — "3.5도" stays whole), at
 * a line break, or when the draft is closed. The reply's FIRST piece is its first sentence (with any other sentences
 * already whole) — or, when that sentence is long (still open at CLAUSE_LONG letters), its first clause (clauseCut).
 * A tiny first sentence ("네!") waits for the next one. Later pieces are whole sentences only. Where the pieces are,
 * is counted in letters of the speech text, so markdown, emoji and spacing settling later can't repeat or skip words.
 */
export function speechCutter(): SpeechCutter {
  let saidText = "";
  let saidNorm = "";
  let saidLetters = 0;
  let off = false;
  return {
    feed(draft, closed = false, final = false) {
      if (off) return [];
      const speech = forSpeech(final ? draft : settledDraft(draft));
      if (!norm(speech).startsWith(saidNorm)) {
        off = true;
        return [];
      }
      const out: string[] = [];
      let skip = saidLetters;
      let open: string | null = null;
      for (const part of sentenceParts(speech, closed || final)) {
        const n = letters(part.text);
        if (skip >= n) {
          skip -= n;
          continue;
        }
        const text = skip > 0 ? afterLetters(part.text, skip) : part.text;
        skip = 0;
        if (!part.closed) {
          open = text;
          break;
        }
        out.push(closeSentence(text));
      }
      if (!saidLetters) {
        // the first piece: a long open first sentence may go up to a clause boundary; a tiny one waits for company
        if (letters(out.join("")) < TINY && open && letters(open) >= CLAUSE_LONG) {
          const cut = clauseCut(open);
          if (cut) out.push(cut);
        }
        if (!closed && !final && letters(out.join("")) < TINY) return [];
      }
      for (const piece of out) {
        saidText = saidText ? `${saidText} ${piece}` : piece;
        saidLetters += letters(piece);
      }
      saidNorm = norm(saidText);
      return out;
    },
    said: () => saidText,
    diverged: () => off,
  };
}
