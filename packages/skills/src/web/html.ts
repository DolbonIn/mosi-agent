/**
 * HTML helpers for web_read: charset decoding, a linear tag tokenizer (text, attributes), regions (main content vs
 * menus) and display forms of hosts and URLs (punycode → Unicode: xn--2o2b11q2e68p.site → 스시자로.site).
 *
 * Regex based on purpose: no DOM, no script ever runs, every pattern is bounded (a hostile page costs linear time).
 * Everything here is untrusted page data.
 */
import { domainToUnicode } from "node:url";
import { decodeEntities } from "../util";

// ───────────────────────────── hosts and URLs ─────────────────────────────

function unicodeHost(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  try {
    return domainToUnicode(h) || h;
  } catch {
    return h;
  }
}

/** "xn--2o2b11q2e68p.site" → "스시자로.site"; "www.example.com" → "example.com" */
export function displayHost(host: string): string {
  return unicodeHost(host).replace(/^www\./, "");
}

/**
 * An absolute URL as people read it: Unicode host (www kept), percent-decoded path and query when that stays a
 * single token, no fragment. `new URL()` turns it back into the ASCII form, so it can be read again as is.
 */
export function displayUrl(u: URL): string {
  const host = u.hostname.includes(":") ? `[${u.hostname.replace(/^\[|\]$/g, "")}]` : unicodeHost(u.hostname);
  const port = u.port ? `:${u.port}` : "";
  let rest = `${u.pathname}${u.search}`;
  try {
    const d = decodeURI(rest);
    if (!/[\s\u0000-\u001f\u007f"<>\\^`{|}]/.test(d)) rest = d;
  } catch {
    /* keep the encoded form */
  }
  return `${u.protocol}//${host}${port}${rest}`;
}

/** the same site: equal hosts once a leading "www." is dropped */
export function sameSite(a: string, b: string): boolean {
  return a.toLowerCase().replace(/^www\./, "") === b.toLowerCase().replace(/^www\./, "");
}

export function stripHash(u: URL): string {
  const c = new URL(u.toString());
  c.hash = "";
  return c.toString().replace(/\/$/, "");
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ───────────────────────────── charset ─────────────────────────────

const CHARSET_ALIASES: Record<string, string> = {
  cp949: "euc-kr",
  ms949: "euc-kr",
  "x-windows-949": "euc-kr",
  uhc: "euc-kr",
  ksc5601: "euc-kr",
  sjis: "shift_jis",
  "x-sjis": "shift_jis",
  ms932: "shift_jis",
  cp932: "shift_jis",
  "windows-31j": "shift_jis",
};

function decoderFor(label: string): TextDecoder | null {
  const l = label.trim().toLowerCase().replace(/^["']|["']$/g, "");
  if (!l) return null;
  for (const name of [l, CHARSET_ALIASES[l]]) {
    if (!name) continue;
    try {
      return new TextDecoder(name);
    } catch {
      /* unknown label */
    }
  }
  return null;
}

/** Decode a page: BOM, then the Content-Type charset, then a <meta charset> in the first 4 KB, else UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const fromHeader = /charset\s*=\s*([^;\s]+)/i.exec(contentType)?.[1];
  let dec = fromHeader ? decoderFor(fromHeader) : null;
  if (!dec) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    const meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1];
    dec = meta ? decoderFor(meta) : null;
  }
  return (dec ?? new TextDecoder("utf-8")).decode(bytes);
}

// ───────────────────────────── text ─────────────────────────────

/** zero-width and bidi control characters (used to hide text or reorder it) */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;

export function clean(s: string): string {
  return s.replace(INVISIBLE, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}

export function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
}

export function metaContent(html: string, key: string): string {
  const re = /<meta\b[^<>]{0,4000}>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = m[0];
    const k = (attr(tag, "name") || attr(tag, "property")).toLowerCase();
    if (k === key) return attr(tag, "content");
  }
  return "";
}

/** [start, end) from the first `<tag` to the start of the last `</tag>` (two linear scans, whatever the input) */
export function spanRange(html: string, tag: string): [number, number] | null {
  const open = new RegExp(`<${tag}\\b`, "i").exec(html);
  if (!open) return null;
  const close = new RegExp(`</${tag}\\s*>`, "gi");
  close.lastIndex = open.index;
  let last = -1;
  for (let m = close.exec(html); m; m = close.exec(html)) last = m.index;
  return last > open.index ? [open.index, last] : null;
}

export function span(html: string, tag: string): string {
  const r = spanRange(html, tag);
  return r ? html.slice(r[0], r[1]) : "";
}

/** where the page's own content is: <main>/<article> when present, minus nav/header/footer/aside blocks (linear) */
export function contentRegion(html: string): (i: number) => boolean {
  const main = spanRange(html, "main") ?? spanRange(html, "article");
  const [lo, hi] = main && main[1] - main[0] > 400 ? main : [0, html.length];
  const chrome: [number, number][] = [];
  const open = /<(nav|header|footer|aside)\b[^<>]{0,2000}>/gi;
  for (let m = open.exec(html); m && chrome.length < 200; m = open.exec(html)) {
    const close = new RegExp(`</${m[1]}\\s*>`, "gi");
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(html);
    const end = c ? c.index + c[0].length : html.length;
    chrome.push([m.index, end]);
    open.lastIndex = end;
  }
  return (i) => i >= lo && i < hi && !chrome.some(([a, b]) => i >= a && i < b);
}

// <head> is walked, not skipped: its <title> is captured and its scripts/styles are skipped one by one
export const SKIP = new Set(["script", "style", "noscript", "svg", "template", "iframe", "canvas", "object", "math"]);
export const CHROME = new Set(["nav", "header", "footer", "aside"]);
const BREAK = new Set(["br", "hr", "p", "div", "section", "article", "main", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "td", "th", "header", "footer", "nav", "aside", "blockquote", "pre", "dd", "dt", "dl", "form", "label", "figcaption", "address"]);
/** a tag, a comment opener, or a declaration — each bounded, so a stray "<" costs at most 2000 characters */
export const TOKEN_SOURCE = String.raw`<!--|<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})\b[^<>]{0,2000}>|<[!?][^<>]{0,2000}>`;
const TOKEN = new RegExp(TOKEN_SOURCE, "g");

/**
 * Empty attribute values of 1500+ characters (a map's JSON in data-pins, inline SVG data, a tracking blob): the
 * tokenizer bounds a tag at 2000 characters, and a longer one would spill its attributes into the text. Linear: each
 * value's scan ends at the next quote.
 */
export function shortAttributes(html: string): string {
  return html.replace(/(\s[\w:.-]{1,80}\s*=\s*)(?:"[^"]{1500,}"|'[^']{1500,}')/g, '$1""');
}

/** the end of `</name>` from `from` on (or the end of the input) */
export function skipTo(html: string, name: string, from: number): number {
  const close = new RegExp(`</${name}\\s*>`, "gi");
  close.lastIndex = from;
  const m = close.exec(html);
  return m ? m.index + m[0].length : html.length;
}

/**
 * HTML → readable text in one linear pass (no backtracking blow-ups on hostile pages): drops comments, scripts,
 * styles and other non-text blocks (an unclosed one hides the rest), breaks lines at block tags, decodes entities.
 * `chrome: false` also drops nav/header/footer/aside.
 */
export function htmlText(html: string, o: { chrome?: boolean } = {}): { title: string; text: string } {
  const parts: string[] = [];
  let title = "";
  let pos = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(html); m; m = TOKEN.exec(html)) {
    parts.push(html.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (m[0] === "<!--") {
      const end = html.indexOf("-->", pos);
      pos = end < 0 ? html.length : end + 3;
    } else if (m[2]) {
      const name = m[2].toLowerCase();
      const closing = m[1] === "/";
      if (!closing && name === "title" && !title) {
        const end = skipTo(html, "title", pos);
        title = html.slice(pos, end).replace(/<\/title\s*>$/i, "");
        pos = end;
      } else if (!closing && (SKIP.has(name) || (o.chrome === false && CHROME.has(name))) && !m[0].endsWith("/>")) {
        pos = skipTo(html, name, pos);
      } else parts.push(BREAK.has(name) ? "\n" : " ");
    } else parts.push(" ");
    TOKEN.lastIndex = pos;
  }
  parts.push(html.slice(pos));
  const text = decodeEntities(parts.join(""))
    // every whitespace but the line break (\r, tabs, NBSP, U+3000 …) is one space; then one break between lines
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
  return { title: decodeEntities(title).replace(/\s+/g, " ").trim(), text };
}

/** body text without navigation chrome: <main> (or <article>) when it has content, else <body> minus nav/header/footer/aside */
export function mainText(html: string): string {
  const best = span(html, "main") || span(html, "article");
  if (best.length > 400) {
    const t = htmlText(best).text;
    if (t.length > 80) return t;
  }
  return htmlText(span(html, "body") || html, { chrome: false }).text;
}

// ───────────────────────────── labels ─────────────────────────────

/** at least two letters or digits */
export const meaningful = (s: string): boolean => (s.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2;
export const LINK_SUFFIX = /\s{0,3}(?:자세히\s?보기|더\s?보기|바로\s?가기|詳しく見る|詳細を見る|read more|learn more)$/i;

export function cleanLabel(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
