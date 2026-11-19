/**
 * Small BM25 with Hangul-aware tokenisation: split on non-letters/digits, keep each run, and add
 * character bigrams for Hangul runs so particles don't block matches ("커피는" ↔ "커피").
 */

const HANGUL_RUN = /[가-힣ㄱ-ㆎ]+|[^가-힣ㄱ-ㆎ]+/g;
const IS_HANGUL = /^[가-힣ㄱ-ㆎ]+$/;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const runs = text.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u);
  for (const run of runs) {
    if (!run) continue;
    for (const seg of run.match(HANGUL_RUN) ?? []) {
      if (IS_HANGUL.test(seg)) {
        out.push(seg);
        for (let i = 0; i + 1 < seg.length; i++) {
          const bg = seg.slice(i, i + 2);
          if (bg !== seg) out.push(bg);
        }
      } else if (seg.length > 1 || /\d/.test(seg)) {
        out.push(seg);
      }
    }
  }
  return out;
}

export interface Bm25Doc<T> {
  text: string;
  item: T;
  /** multiplier applied to the score (e.g. durable facts > chat logs) */
  boost?: number;
}

export function bm25Search<T>(docs: Bm25Doc<T>[], query: string, limit = 5, k1 = 1.2, b = 0.75): { item: T; score: number }[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokenize(d.text));
  const avg = toks.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length;
  const scored = docs.map((d, i) => {
    const t = toks[i]!;
    const tf = new Map<string, number>();
    for (const term of t) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg));
    }
    return { item: d.item, score: score * (d.boost ?? 1) };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.max(0, limit));
}
