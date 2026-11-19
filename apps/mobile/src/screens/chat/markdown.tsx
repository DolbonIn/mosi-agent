import { memo, type ReactNode } from "react";
import { glued } from "../../ui/Text";

/**
 * Light markdown for assistant text (protocol: **bold**, lists, `code`, links). One parser for finished messages and
 * the streaming draft: text → blocks → styled inline runs. Markers are never shown — an unclosed `**` while streaming
 * styles the rest of the run instead of flashing asterisks. Each source line is its own block (chat text uses single
 * newlines as breaks); a blank line before a block becomes extra space (`gap`). A line that is nothing but bold text
 * ("**정한 것**") is a section head (`h3`), and as a message's first line ("**회의 요약**") its title (`h2`): models write
 * headings that way, and the meeting summary does (meeting B: title, section heads, list rhythm).
 */
export interface Run {
  t: string;
  b?: boolean;
  i?: boolean;
  code?: boolean;
  href?: string;
  /** the link's text is a URL (a bare URL, or a label such as "clinic.dmm.com"): it breaks only between `urlPieces` */
  url?: boolean;
}

export type Block =
  | { kind: "p"; runs: Run[]; gap: boolean }
  | { kind: "h"; level: 1 | 2 | 3; runs: Run[]; gap: boolean }
  | { kind: "li"; ordered: boolean; marker: string; depth: number; runs: Run[]; gap: boolean; check?: boolean }
  | { kind: "quote"; runs: Run[]; gap: boolean }
  | { kind: "code"; text: string; gap: boolean; open: boolean }
  | { kind: "hr"; gap: boolean };

const URL_RE = /https?:\/\/[^\s<>()[\]"']+[^\s<>()[\]"'.,!?;:)]/y;
/** a "*" right before VS16 or the keycap mark is the keycap emoji "*️⃣" (U+002A U+FE0F U+20E3), never an emphasis mark */
const keycapAt = (s: string, k: number) => s[k] === "*" && (s[k + 1] === "\uFE0F" || s[k + 1] === "\u20E3");
/** the next `c` from `from` that is a mark (a keycap's "*" is not), or -1 */
function nextMark(s: string, c: string, from: number): number {
  for (let j = s.indexOf(c, from); j >= 0; j = s.indexOf(c, j + 1)) if (!keycapAt(s, j)) return j;
  return -1;
}
/** a link label that is an address ("clinic.dmm.com", "www.a.jp/b"), drawn as a URL */
const URL_LABEL = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?)$/i;

/** Inline tokenizer: ** __ (bold), * _ (italic, ASCII-delimited only), ` (code), [text](url), bare URLs. The keycap
 * "*️⃣" keeps its "*" (keycapAt): it opens, closes and counts as no mark. */
export function parseInline(src: string, streaming = false): Run[] {
  let text = src;
  if (streaming) {
    // an unfinished link while streaming: show its label as plain text until it closes
    text = text.replace(/\[([^\]\n]*)(?:\]\(?[^)\s]*)?$/, "$1");
  }
  const runs: Run[] = [];
  let b = false;
  let i = false;
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const last = runs[runs.length - 1];
    if (last && !last.code && !last.href && !!last.b === b && !!last.i === i) last.t += buf;
    else runs.push({ t: buf, ...(b ? { b } : {}), ...(i ? { i } : {}) });
    buf = "";
  };
  for (let k = 0; k < text.length; ) {
    const c = text[k]!;
    const two = text.slice(k, k + 2);
    if ((two === "**" && !keycapAt(text, k + 1)) || two === "__") {
      flush();
      b = !b;
      k += 2;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", k + 1);
      if (end < 0) {
        if (streaming) {
          flush();
          runs.push({ t: text.slice(k + 1), code: true });
          break;
        }
        buf += c;
        k++;
        continue;
      }
      flush();
      runs.push({ t: text.slice(k + 1, end), code: true });
      k = end + 1;
      continue;
    }
    if (c === "[") {
      const m = /^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/.exec(text.slice(k));
      if (m) {
        flush();
        runs.push({ t: m[1]!, href: m[2]!, ...(b ? { b } : {}), ...(URL_LABEL.test(m[1]!) ? { url: true } : {}) });
        k += m[0].length;
        continue;
      }
    }
    if ((c === "h" && (text.startsWith("http://", k) || text.startsWith("https://", k))) && (k === 0 || /[\s(（]/.test(text[k - 1]!))) {
      URL_RE.lastIndex = k;
      const m = URL_RE.exec(text);
      if (m) {
        flush();
        runs.push({ t: m[0], href: m[0], url: true });
        k += m[0].length;
        continue;
      }
    }
    if ((c === "*" || c === "_") && !keycapAt(text, k)) {
      // italic only between ASCII-ish word boundaries (Korean underscores in ids stay literal); a mark before a space
      // never opens, and closes when a word ends there ("*강조* 그리고")
      const prev = text[k - 1];
      const opening = !i && text[k + 1] !== " " && (k === 0 || /[\s(（"']/.test(prev!)) && nextMark(text, c, k + 1) > k + 1;
      const closing = i && prev !== " ";
      if (opening || closing) {
        flush();
        i = !i;
        k++;
        continue;
      }
    }
    buf += c;
    k++;
  }
  flush();
  return runs;
}

/** Text → blocks. `streaming`: the last line may be unfinished. */
export function parseBlocks(text: string, streaming = false): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let gap = false;
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!;
    const line = raw.replace(/\s+$/, "");
    const last = streaming && n === lines.length - 1;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      let m = n + 1;
      while (m < lines.length && !/^\s*```/.test(lines[m]!)) body.push(lines[m++]!);
      const open = m >= lines.length;
      out.push({ kind: "code", text: body.join("\n"), gap, open });
      gap = false;
      n = m;
      continue;
    }
    if (!line.trim()) {
      if (out.length) gap = true;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: "h", level: h[1]!.length as 1 | 2 | 3, runs: parseInline(h[2]!, last), gap });
      gap = false;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push({ kind: "hr", gap });
      gap = false;
      continue;
    }
    const li = /^(\s*)([-*•]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const box = /^\[( |x|X)\]\s+(.*)$/.exec(li[3]!);
      const body = box ? box[2]! : li[3]!;
      out.push({ kind: "li", ordered, marker: ordered ? li[2]!.replace(")", ".") : "•", depth: Math.min(2, Math.floor(li[1]!.length / 2)), runs: parseInline(body, last), gap, ...(box ? { check: box[1] !== " " } : {}) });
      gap = false;
      continue;
    }
    const bold = /^\s*\*\*([^*\n]+?)\*\*\s*[:：]?\s*$/.exec(line);
    if (bold) {
      out.push({ kind: "h", level: out.length === 0 ? 2 : 3, runs: [{ t: bold[1]!.trim() }], gap });
      gap = false;
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      out.push({ kind: "quote", runs: parseInline(q[1]!, last), gap });
      gap = false;
      continue;
    }
    out.push({ kind: "p", runs: parseInline(line, last), gap });
    gap = false;
  }
  return out;
}

export const runsText = (runs: Run[]) => runs.map((r) => r.t).join("");

/** Slice styled runs by character offsets into the concatenated text. */
export function sliceRuns(runs: Run[], start: number, end: number): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const a = pos;
    const z = pos + r.t.length;
    pos = z;
    if (z <= start || a >= end) continue;
    out.push({ ...r, t: r.t.slice(Math.max(0, start - a), Math.min(r.t.length, end - a)) });
  }
  return out;
}

/**
 * Blocks whose text keeps its spaces (`white-space: pre-wrap`: `.md p`, `.md-li-body`). Only there is a run glued with
 * the run before it: in a block under `normal` Chrome breaks before a glued " ·" that opens a run right after an
 * element's end and draws its space at the next line's start (+4.3 px; FOUNDATION › Line breaks › `glued`). Heads and
 * quotes stay `normal` (the archive draws the same class names); none of the saved replies' heads has such a spot, and
 * none of them holds a quote.
 */
export const keepsSpaces = (b: Block) => b.kind === "p" || b.kind === "li";

const GRAPHEMES = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const graphemes = (t: string): string[] => (GRAPHEMES ? Array.from(GRAPHEMES.segment(t), (g) => g.segment) : Array.from(t));
const URL_SEP = /^[/.\-_?#&=~%+|!]$/;
const URL_OPEN = /^[\p{Ps}\p{Pi}]$/u;
const URL_CLOSE = /^[\p{Pe}\p{Pf}、。，．・ー]$/u;
// a grapheme's width in em, over the system font's in both engines: m w M W @ % 1, capitals 0.75, digits 0.62, narrow
// letters and marks 0.35, other ASCII 0.6; Hangul, kana and Han 1, anything longer than one unit (an emoji) 1.25
const urlEm = (g: string) =>
  g.length > 1 ? 1.25 : /[^\x21-\x7e]/.test(g) ? 1 : /[mwMW@%]/.test(g) ? 1 : /[A-Z]/.test(g) ? 0.75 : /\d/.test(g) ? 0.62 : /[fijlrt.,:;'!|/-]/.test(g) ? 0.35 : 0.6;
/** a piece up to this wide never breaks (199 px at text size 130 %, as wide as a glued run may be; the saved replies'
 * widest nowrap piece is 7.05 em in both engines); a wider one (an id, a long path word) breaks only where it
 * overflows (`urlLong`) */
export const URL_PIECE_EM = 9;

/**
 * A URL's text as the pieces it may break between: after a "/" "." "-" "_" "?" "#" "&" "=" "~" "%" "+" "|" "!" (a run
 * of them stays together: "https://"), and before an opening bracket; never after an opening bracket or before a
 * closing one. So no line starts on "." "/" or ")" (the line-start rule the rest of the reply keeps), and none ends on
 * "(". Never inside a grapheme. Each break is decided by what comes before it and the next character, so a URL still
 * streaming in breaks where the finished one does, and a piece is the same whether the line starts at the URL or at
 * one of its breaks.
 */
export function urlPieces(t: string): string[] {
  const out: string[] = [];
  let piece = "";
  let prev = "";
  for (const g of graphemes(t)) {
    const cut = piece !== "" && !URL_OPEN.test(prev) && !URL_CLOSE.test(g) && ((URL_SEP.test(prev) && !URL_SEP.test(g)) || URL_OPEN.test(g));
    if (cut) {
      out.push(piece);
      piece = "";
    }
    piece += g;
    prev = g;
  }
  if (piece) out.push(piece);
  return out;
}

/** a piece past URL_PIECE_EM as [head, middle, tail]: the middle breaks only where it overflows (.md-link
 * overflow-wrap: anywhere; no mark is left in it), its first grapheme with the openers before it and its last with the
 * marks and closers after it never do (no line ends on "(", none starts on "/" "." or ")") */
export function urlLong(p: string): [string, string, string] | null {
  const gs = graphemes(p);
  if (gs.reduce((n, g) => n + urlEm(g), 0) <= URL_PIECE_EM) return null;
  let h = 0;
  while (h < gs.length - 1 && URL_OPEN.test(gs[h]!)) h++;
  let e = gs.length - 1;
  while (e > 0 && (URL_SEP.test(gs[e]!) || URL_CLOSE.test(gs[e]!))) e--;
  if (e <= h + 1) return null;
  return [gs.slice(0, h + 1).join(""), gs.slice(h + 1, e).join(""), gs.slice(e).join("")];
}

/** a URL drawn piece by piece: a piece never breaks inside (nowrap), an empty box between two pieces is the break
 * (chat.css .md-url, .md-url-brk); a piece past URL_PIECE_EM breaks where it overflows (`urlLong`) */
function urlText(t: string): ReactNode[] {
  return urlPieces(t).flatMap((p, k) => {
    const long = urlLong(p);
    const piece = long ? (
      <span key={k}>
        <span className="md-url">{long[0]}</span>
        {long[1]}
        <span className="md-url">{long[2]}</span>
      </span>
    ) : (
      <span key={k} className="md-url">
        {p}
      </span>
    );
    return k ? [<span key={`b${k}`} className="md-url-brk" />, piece] : [piece];
  });
}

/**
 * Runs as nodes. Text, bold and italic have their tight spots glued (FOUNDATION › Line breaks, `glued()`): WebKit's
 * keep-all broke after "(" ("8,000엔( / 내원)") and inside numbers ("10, / 200엔") in about half the saved replies at
 * 390. In a block that keeps its spaces (`spaces`, `keepsSpaces`) each run is glued with the run before it as
 * `before`: a " ·" after a bold name or a link ("**구름 클리닉** · …", 2664 run starts over the saved replies' list
 * items) rides on its word, and an opener after one gets its break. Code stays as written, and so does a link's text.
 * A link that reads as a URL (`url`) breaks only between its `urlPieces`: WebKit's own breaks after "/" and "." come
 * and go with the elements around the URL, so the stream's last line (the URL at its end) and the finished answer
 * broke one URL two ways and the reply moved at the swap (−79 px in reply 20 at 390). Other link text breaks anywhere
 * (.md-link overflow-wrap: anywhere). While streaming each visual line's slice is glued on its own (its first run with
 * no `before`): a line starts where the browser broke, never inside a glue or a URL piece.
 */
export function renderRuns(runs: Run[], spaces = false): ReactNode[] {
  return runs.map((r, k) => {
    const text = r.code || r.href ? r.t : glued(r.t, spaces ? runs[k - 1]?.t : undefined);
    let node: ReactNode = text;
    if (r.code) node = <code className="md-code">{r.t}</code>;
    if (r.href)
      node = (
        <a className="md-link" href={r.href} target="_blank" rel="noopener noreferrer">
          {r.url ? urlText(r.t) : text}
        </a>
      );
    if (r.i) node = <em>{node}</em>;
    if (r.b) node = <strong>{node}</strong>;
    return <span key={k}>{node}</span>;
  });
}

export function blockClass(b: Block): string {
  const base = b.kind === "h" ? `md-h md-h${b.level}` : b.kind === "li" ? `md-li md-li-d${b.depth}${b.ordered ? " md-ol" : ""}` : `md-${b.kind}`;
  return `${base}${b.gap ? " md-gap" : ""}`;
}

/** One block's frame (marker for list items); `children` is the inline content. */
export function BlockFrame({ block, children }: { block: Block; children?: ReactNode }) {
  const cls = blockClass(block);
  switch (block.kind) {
    case "hr":
      return <hr className={cls} />;
    case "code":
      return (
        <pre className={cls}>
          <code>{block.text}</code>
        </pre>
      );
    case "li":
      return (
        <div className={cls}>
          {block.check !== undefined ? (
            <span className="md-check" data-on={block.check || undefined} role="img" aria-label={block.check ? "완료" : "할 일"} />
          ) : (
            <span className="md-marker tnum" aria-hidden="true">
              {block.marker}
            </span>
          )}
          <span className="md-li-body">{children}</span>
        </div>
      );
    case "h":
      return (
        <div className={cls} role="heading" aria-level={block.level + 2}>
          {children}
        </div>
      );
    case "quote":
      return <blockquote className={cls}>{children}</blockquote>;
    default:
      return <p className={cls}>{children}</p>;
  }
}

/** Static markdown (finished messages). */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      {blocks.map((b, k) => (
        <BlockFrame key={k} block={b}>
          {"runs" in b ? renderRuns(b.runs, keepsSpaces(b)) : null}
        </BlockFrame>
      ))}
    </div>
  );
});
