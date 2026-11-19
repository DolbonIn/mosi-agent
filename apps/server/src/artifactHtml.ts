/**
 * HTML artifacts (kind "html", made by sys_create_artifact): the agent's own HTML/CSS for an answer that is a screen
 * (a community-thread mock-up, schedule cards, a comparison table, a poster). The app renders it in a sandboxed iframe
 * with its own CSP: that is the main defence. This module is the second one: what is stored is inert even outside it.
 *
 * `cleanArtifactHtml` re-serialises the fragment token by token (no DOM): everything it emits is a well-formed tag with
 * quoted, escaped attributes, escaped text, or CSS that cannot close its <style>. Removed:
 *  - elements with their content: script, iframe, frame(set), object, embed, applet, noscript, noembed, noframes, xmp,
 *    plaintext, template, title, math, portal, fencedframe; tags only (content kept): html, head, body, link, base, meta,
 *    form
 *  - every on* attribute, srcdoc, srcset/imagesrcset, ping, action, formaction, http-equiv
 *  - resource URLs (src, poster, background, data, SVG image/use/feImage href) unless `data:image/…`; CSS url(), image-set
 *    and src() the same way; @import, expression(), behavior, -moz-binding
 *  - link hrefs (a, area) other than https:// (http, mailto, tel, #, relative, javascript: behind entities …)
 *  - SVG <set>/<animate*> that target an href
 * Comments, doctypes and CDATA go too. Counts of what went are returned (for the tool's note to the model), never text.
 *
 * Two card rules models keep breaking are then fixed in the cleaned CSS (`tuneCss`, outside <svg> only, counted in
 * `tuned`): a font size under 13px becomes 13px (a relative one, .8em or 80% of a 14px table, gets max(13px,…)), and
 * `color: var(--text-3)` becomes `var(--text-2)` (--text-3 is for dots, rails and icons; as text it fails contrast).
 */

export { MAX_ARTIFACT_HTML_BYTES, MAX_ARTIFACT_HTML_CARD_BYTES } from "@pickle/protocol";

export interface HtmlRemovals {
  /** script, iframe, object, embed … elements */
  elements: number;
  /** on* handlers and other active attributes (srcdoc, formaction, action …) */
  handlers: number;
  /** remote or non-image resource URLs (src, srcset, CSS url(), @import …) */
  remote: number;
  /** links with a scheme other than http(s)/mailto/tel/# */
  links: number;
}

/** what tuneCss changed (design rules, not safety) */
export interface CssTunes {
  /** font sizes under 13px raised to 13px */
  fontSize: number;
  /** text colours moved from --text-3 to --text-2 */
  textColor: number;
}

const MIN_FONT_PX = 13;
const toPx = (n: number, unit: string) => (unit === "rem" ? n * 16 : unit === "pt" ? (n * 4) / 3 : n);
const raiseSize = (tunes: CssTunes) => (m: string, sp: string, n: string, unit: string) => {
  const px = toPx(Number(n), unit.toLowerCase());
  if (px === 0 || px >= MIN_FONT_PX) return m; // 0 is the inline-block whitespace trick
  tunes.fontSize++;
  return `${sp}${MIN_FONT_PX}px`;
};

/** relative units: their size depends on the parent (.8em of a 14px table is 11.2px), so the floor goes in max() */
const REL_UNIT = "em|%|ex|ch|cap|ic|lh|rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|cqw|cqh|cqi|cqb|cqmin|cqmax";
const FLOORED = new RegExp(`^max\\(\\s*${MIN_FONT_PX}px\\s*,`, "i");
/** keywords under 13px at the frame's 16px medium (small is 13px): xx-small 9px, x-small 10px; smaller is ÷1.2 */
const SMALL_SIZE = new Map([
  ["xx-small", `${MIN_FONT_PX}px`],
  ["x-small", `${MIN_FONT_PX}px`],
  ["smaller", `max(${MIN_FONT_PX}px,.8333em)`],
]);
/** a relative size (counted as raised when it is surely under 1: .8em, 80%), or a function of anything (calc, var …) */
function floorRelative(size: string, tunes: CssTunes): string | null {
  const kw = SMALL_SIZE.get(size.toLowerCase());
  if (kw) {
    tunes.fontSize++;
    return kw;
  }
  if (FLOORED.test(size)) return null;
  const rel = new RegExp(`^(\\d*\\.?\\d+)(${REL_UNIT})$`, "i").exec(size);
  if (rel) {
    const n = Number(rel[1]);
    if (n === 0) return null;
    if (rel[2] === "%" ? n < 100 : /^(em|ex|ch|cap|ic)$/i.test(rel[2]!) && n < 1) tunes.fontSize++;
    return `max(${MIN_FONT_PX}px,${size})`;
  }
  if (/^(calc|clamp|min|max|var|env)\(.*\)$/i.test(size)) return `max(${MIN_FONT_PX}px,${size})`;
  return null;
}

/**
 * The card's type and contrast floor on already-cleaned CSS (a <style> block or a style attribute): `font-size` (px,
 * rem at a 16 px root, pt) and the `font` shorthand's size under 13px → 13px; a relative size (em, %, vw …) or a
 * function (calc, clamp, min, max, var, env) → `max(13px,<size>)`, xx-small / x-small → 13px, smaller →
 * `max(13px,.8333em)` (0 stays); `color` / `-webkit-text-fill-color: var(--text-3…)` → `var(--text-2…)` (background,
 * border, fill and stroke keep --text-3). Only sizes and a variable name change, so it cannot undo what cleanCss
 * removed.
 */
export function tuneCss(css: string, tunes: CssTunes): string {
  // a declaration: a property right after { ; or the start (a style attribute), its value up to ; { } or the end
  return css.replace(/(^|[{;]\s*)([a-zA-Z-]+)(\s*:\s*)([^;{}]*)/g, (all, pre: string, prop: string, colon: string, value: string) => {
    const p = prop.toLowerCase();
    let v = value;
    if (p === "font-size") {
      v = v.replace(/^(\s*)(\d*\.?\d+)(px|rem|pt)\b/i, raiseSize(tunes));
      if (v === value) {
        const m = /^(\s*)(.*?)(\s*(?:!\s*important)?\s*)$/i.exec(v)!;
        const floored = floorRelative(m[2]!, tunes);
        if (floored) v = `${m[1]}${floored}${m[3]}`;
      }
    }
    // [style] [weight] size[/line-height] family: the first length followed by / or more of the shorthand
    else if (p === "font") {
      v = v.replace(/(^|\s)(\d*\.?\d+)(px|rem|pt)(?=\s*\/|\s+\S)/i, raiseSize(tunes));
      if (v === value)
        v = v.replace(new RegExp(`(^|\\s)(\\d*\\.?\\d+(?:${REL_UNIT})|xx-small|x-small|smaller)(?=\\s*\\/|\\s+\\S)`, "i"), (all2, sp: string, size: string) => {
          const floored = floorRelative(size, tunes);
          return floored ? `${sp}${floored}` : all2;
        });
    }
    else if (p === "color" || p === "-webkit-text-fill-color")
      v = v.replace(/^(\s*)var\(\s*--text-3\s*(\)|,)/i, (_m, sp: string, end: string) => {
        tunes.textColor++;
        return `${sp}var(--text-2${end}`;
      });
    return v === value ? all : `${pre}${prop}${colon}${v}`;
  });
}

const DROP_RAW = new Set(["script", "iframe", "noscript", "noembed", "noframes", "xmp", "title", "plaintext"]);
const DROP_NESTED = new Set(["frameset", "object", "applet", "template", "math", "portal", "fencedframe"]);
const DROP_TAG = new Set(["html", "head", "body", "link", "base", "meta", "frame", "embed", "keygen", "isindex", "form"]);
const DROP_ATTRS = new Set(["srcdoc", "srcset", "imagesrcset", "ping", "action", "formaction", "http-equiv"]);
const RESOURCE_ATTRS = new Set(["src", "poster", "background", "data", "lowsrc", "dynsrc", "codebase", "manifest", "icon"]);
const LINK_TAGS = new Set(["a", "area"]);
const ANIMATIONS = new Set(["set", "animate", "animatemotion", "animatetransform", "animatecolor"]);
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const ATTR_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
const WS = /[\t\n\f\r ]/;

/** named entities a URL scheme or CSS could be spelled with (the browser decodes them before using the value) */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", tab: "\t", newline: "\n", colon: ":", lpar: "(",
  rpar: ")", sol: "/", bsol: "\\", num: "#", period: ".", comma: ",", semi: ";", excl: "!", quest: "?", equals: "=",
  commat: "@", lowbar: "_", hyphen: "-", dash: "-", plus: "+", percnt: "%", dollar: "$", lsqb: "[", rsqb: "]",
  lbrack: "[", rbrack: "]", lcub: "{", rcub: "}", lbrace: "{", rbrace: "}", verbar: "|", vert: "|", ast: "*",
  midast: "*", grave: "`", hat: "^", tilde: "~",
};

/** the value as the browser reads it; null when a named entity we don't know is in it (so it can't be judged),
 * unless `lenient` (then it stays as written) */
function decodeEntities(v: string, lenient = false): string | null {
  let unknown = false;
  const out = v.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    }
    const named = ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    // "&copy" and friends are harmless in text; in a URL or CSS they make the value unjudgeable
    if (m.endsWith(";") && !lenient) unknown = true;
    return m;
  });
  return unknown ? null : out;
}

const escAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** a raw (undecoded) attribute value, quoted again: entities stay as written */
const requoteRaw = (v: string) => v.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** whitespace and control characters out, lower-cased: how a browser finds a URL's scheme */
const schemeView = (v: string) => v.replace(/[\u0000- \u007f-\u009f]+/g, "").toLowerCase();
const isDataImage = (v: string) => /^data:image\/[a-z0-9.+-]+[;,]/.test(schemeView(v));
const isLocalOrDataImage = (v: string) => schemeView(v).startsWith("#") || isDataImage(v);
/** a link the app may offer to open: https only (the app asks first); http, mailto, tel, #, relative ones lose it */
const isSafeLink = (v: string) => schemeView(v).startsWith("https://");

// ───────────────────────────── CSS ─────────────────────────────

/**
 * CSS escapes that spell a function or at-rule name ("\75 rl(" = "url(", "\@import", "\-webkit-image-set(") become
 * plain, so the checks below see them. Others keep their escape as written: digits (".\31 23"), ":" and "/" (".md\:flex",
 * ".w-1\/2"), "(" (an escaped paren never opens a call), quotes, non-ASCII. A URL spelled with escapes is not
 * recognised as "#…" or "data:image/…" and so is replaced, never let through.
 */
function unescapeCss(css: string): string {
  return css.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\n\r\f0-9a-fA-F])/g, (m, hex: string | undefined, ch: string | undefined) => {
    const c = hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : ch!;
    return /^[A-Za-z@-]$/.test(c) ? c : m;
  });
}

/** the end of a parenthesised call that starts at `open` (index of "("), strings and nesting respected; -1 = EOF */
function closeParen(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = stringEnd(css, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** index of the quote closing the string opened at `at`; -1 when it never closes */
function stringEnd(css: string, at: number): number {
  const q = css[at]!;
  for (let i = at + 1; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\\") i++;
    else if (c === q) return i;
    else if (c === "\n") return -1;
  }
  return -1;
}

/** the URL inside url(…) / src(…): the unquoted body or the first string */
function callUrl(body: string): string {
  const t = body.trim();
  if (t[0] === '"' || t[0] === "'") {
    const end = stringEnd(t, 0);
    return end < 0 ? t.slice(1) : t.slice(1, end);
  }
  return t;
}

/** a CSS call that can fetch (cleanCss decides which survive) */
const CSS_FETCH = /(?<![\w-])(url|src|(?:-webkit-)?image-set|image|cross-fade)\s*\(/i;

const STRING_RE = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;

export function cleanCss(input: string, removed: HtmlRemovals): string {
  let css = unescapeCss(input.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " "));
  // @import (with or without url()) fetches a stylesheet
  css = css.replace(/@import\b[^;]*(?:;|$)/gi, () => {
    removed.remote++;
    return "";
  });
  // url(), src(), image-set(), image(), cross-fade(): only data: images survive
  const FN = /(?<![\w-])(url|src|(?:-webkit-)?image-set|image|cross-fade)\(/gi;
  let out = "";
  let last = 0;
  for (let m = FN.exec(css); m; m = FN.exec(css)) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(css, open);
    const body = css.slice(open + 1, close < 0 ? css.length : close);
    const name = m[1]!.toLowerCase();
    let ok: boolean;
    // a local reference (fill: url(#grad), filter: url(#f)) fetches nothing
    if (name === "url" || name === "src") ok = isLocalOrDataImage(callUrl(body)) && !/var\(/i.test(body);
    else if (/var\(|attr\(/i.test(body)) ok = false; // a URL could come from elsewhere
    else {
      // image-set("a.png" 1x, url(b.png) 2x): every URL or string in it must be a data: image
      const urls = [...body.matchAll(STRING_RE)].map((s) => s[1] ?? s[2] ?? "");
      for (const u of body.matchAll(/url\(([^)]*)\)?/gi)) urls.push(callUrl(u[1] ?? ""));
      ok = urls.length > 0 ? urls.every(isDataImage) : !/[:/]/.test(body);
    }
    out += css.slice(last, m.index);
    if (ok) out += css.slice(m.index, close < 0 ? css.length : close + 1);
    else {
      out += "none";
      removed.remote++;
    }
    last = close < 0 ? css.length : close + 1;
    FN.lastIndex = last;
  }
  css = out + css.slice(last);
  // legacy script hooks
  css = css.replace(/expression\s*\(/gi, "x-blocked(").replace(/(?<![\w-])(behavior|-moz-binding)\s*:/gi, "x-blocked:");
  // nothing in it may close the <style> it sits in ("<" is never needed outside a string)
  return css.replace(/</g, "\\3c ");
}

// ───────────────────────────── HTML ─────────────────────────────

interface Attr {
  name: string;
  /** null = no value (boolean attribute) */
  value: string | null;
}

/** parse the attributes of a tag starting at `i` (after its name); → attributes and the index after ">", or -1 at EOF */
function parseAttrs(s: string, i: number): { attrs: Attr[]; end: number; selfClosing: boolean } {
  const attrs: Attr[] = [];
  let selfClosing = false;
  while (i < s.length) {
    const c = s[i]!;
    if (WS.test(c)) {
      i++;
      continue;
    }
    if (c === "/") {
      if (s[i + 1] === ">") {
        selfClosing = true;
        return { attrs, end: i + 2, selfClosing };
      }
      i++;
      continue;
    }
    if (c === ">") return { attrs, end: i + 1, selfClosing };
    // attribute name: anything up to whitespace, "/", ">" or "=" (a leading "=" belongs to the name)
    let j = i + 1;
    while (j < s.length && !WS.test(s[j]!) && s[j] !== "/" && s[j] !== ">" && s[j] !== "=") j++;
    const name = s.slice(i, j);
    i = j;
    while (i < s.length && WS.test(s[i]!)) i++;
    if (s[i] !== "=") {
      attrs.push({ name, value: null });
      continue;
    }
    i++;
    while (i < s.length && WS.test(s[i]!)) i++;
    const q = s[i];
    if (q === '"' || q === "'") {
      const end = s.indexOf(q, i + 1);
      if (end < 0) return { attrs, end: -1, selfClosing };
      attrs.push({ name, value: s.slice(i + 1, end) });
      i = end + 1;
    } else {
      let k = i;
      while (k < s.length && !WS.test(s[k]!) && s[k] !== ">") k++;
      attrs.push({ name, value: s.slice(i, k) });
      i = k;
    }
  }
  return { attrs, end: -1, selfClosing };
}

/** index where a raw-text element's content ends ("</name" then whitespace, "/" or ">"); s.length when it never does */
function rawEnd(s: string, from: number, name: string): number {
  const re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
  re.lastIndex = from;
  const m = re.exec(s);
  return m ? m.index : s.length;
}

/** past the ">" of the end tag at `at` (attributes and quotes honoured); s.length at EOF */
function pastEndTag(s: string, at: number, nameLen: number): number {
  const r = parseAttrs(s, at + 2 + nameLen);
  return r.end < 0 ? s.length : r.end;
}

/** `tunes` null inside <svg> (and on <svg> itself): its sizes are in user units, scaled by the viewBox */
function cleanAttrs(tag: string, attrs: Attr[], removed: HtmlRemovals, tunes: CssTunes | null): string | null {
  const t = tag.toLowerCase();
  let out = "";
  const seen = new Set<string>();
  for (const a of attrs) {
    const n = a.name.toLowerCase();
    if (!ATTR_NAME.test(a.name) || seen.has(n)) continue; // the browser keeps the first of duplicates; so do we
    seen.add(n);
    if (n.startsWith("on") || DROP_ATTRS.has(n)) {
      if (n.startsWith("on") || n === "srcdoc" || n === "formaction" || n === "action" || n === "http-equiv") removed.handlers++;
      else removed.remote++;
      continue;
    }
    if (ANIMATIONS.has(t) && n === "attributename") {
      const target = decodeEntities(a.value ?? "");
      if (target === null || /href/i.test(target)) return null;
    }
    if (a.value === null) {
      out += ` ${a.name}`;
      continue;
    }
    const isHref = n === "href" || n === "xlink:href";
    if (n === "style" || isHref || RESOURCE_ATTRS.has(n)) {
      const v = decodeEntities(a.value);
      if (v === null) {
        if (n === "style") removed.remote++;
        else if (isHref && LINK_TAGS.has(t)) removed.links++;
        else removed.remote++;
        continue;
      }
      if (n === "style") {
        const css = cleanCss(v, removed);
        out += ` style="${escAttr(tunes ? tuneCss(css, tunes) : css)}"`;
        continue;
      }
      // SVG references: same-document "#id"; <image>/<feImage> may also hold a data: image
      const ok = isHref
        ? LINK_TAGS.has(t)
          ? isSafeLink(v)
          : schemeView(v).startsWith("#") || ((t === "image" || t === "feimage") && isDataImage(v))
        : isDataImage(v);
      if (!ok) {
        if (isHref && LINK_TAGS.has(t)) removed.links++;
        else removed.remote++;
        continue;
      }
      out += ` ${a.name}="${escAttr(v)}"`;
      continue;
    }
    // SVG presentation attributes take url() too (fill, filter, mask, clip-path, marker-*, cursor)
    if (/url|src|image|&/i.test(a.value) && CSS_FETCH.test(unescapeCss(decodeEntities(a.value, true)!))) {
      const v = decodeEntities(a.value);
      if (v === null) {
        removed.remote++;
        continue;
      }
      out += ` ${a.name}="${escAttr(cleanCss(v, removed))}"`;
      continue;
    }
    out += ` ${a.name}="${requoteRaw(a.value)}"`;
  }
  return out;
}

/**
 * The stored form of an HTML artifact: a fragment (<style> blocks and body markup), document wrapper stripped,
 * everything active removed (see the module comment). Pure and total: any input gives some output.
 */
export function cleanArtifactHtml(input: string): { html: string; removed: HtmlRemovals; tuned: CssTunes } {
  const s = input.replace(/\u0000/g, "�");
  const removed: HtmlRemovals = { elements: 0, handlers: 0, remote: 0, links: 0 };
  const tuned: CssTunes = { fontSize: 0, textColor: 0 };
  let out = "";
  let i = 0;
  // inside an element dropped with its content (math, object …): its name and how deep we are
  let dropping: { name: string; depth: number } | null = null;
  // open <svg> elements: inside one a <style> is not raw text, so the browser decodes entities in its CSS
  let svgDepth = 0;
  const text = (t: string) => {
    if (!dropping) out += t.replace(/</g, "&lt;");
  };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      text(s.slice(i));
      break;
    }
    text(s.slice(i, lt));
    i = lt;
    const next = s[i + 1] ?? "";
    // comments, doctypes, CDATA, processing instructions: dropped
    if (s.startsWith("<!--", i)) {
      if (s.startsWith("<!-->", i)) i += 5;
      else if (s.startsWith("<!--->", i)) i += 6;
      else {
        const a = s.indexOf("-->", i + 4);
        const b = s.indexOf("--!>", i + 4);
        const end = a < 0 ? b : b < 0 ? a : Math.min(a, b);
        i = end < 0 ? s.length : end + (end === b ? 4 : 3);
      }
      continue;
    }
    if (next === "!" || next === "?") {
      const end = s.indexOf(">", i + 2);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (next === "/") {
      const m = /^[a-zA-Z][^\t\n\f\r />]*/.exec(s.slice(i + 2, i + 2 + 64));
      if (!m) {
        if (s[i + 2] === ">") i += 3; // "</>": ignored
        else {
          const end = s.indexOf(">", i + 2); // bogus comment
          i = end < 0 ? s.length : end + 1;
        }
        continue;
      }
      const name = m[0];
      const lower = name.toLowerCase();
      i = pastEndTag(s, i, name.length);
      if (dropping) {
        if (lower === dropping.name && --dropping.depth === 0) dropping = null;
        continue;
      }
      if (DROP_TAG.has(lower) || DROP_RAW.has(lower) || DROP_NESTED.has(lower) || lower === "style" || !TAG_NAME.test(name)) continue;
      if (lower === "svg") svgDepth = Math.max(0, svgDepth - 1);
      out += `</${name}>`;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      text("<");
      i++;
      continue;
    }
    // a start tag
    let j = i + 1;
    while (j < s.length && !WS.test(s[j]!) && s[j] !== "/" && s[j] !== ">") j++;
    const name = s.slice(i + 1, j);
    const lower = name.toLowerCase();
    const parsed = parseAttrs(s, j);
    if (parsed.end < 0) break; // EOF inside a tag: the browser drops it too
    i = parsed.end;
    if (dropping) {
      if (lower === dropping.name && !parsed.selfClosing) dropping.depth++;
      continue;
    }
    if (DROP_RAW.has(lower)) {
      removed.elements += lower === "title" ? 0 : 1;
      if (lower === "plaintext") break;
      const end = rawEnd(s, i, lower);
      i = end >= s.length ? s.length : pastEndTag(s, end, lower.length);
      continue;
    }
    if (lower === "style") {
      const end = rawEnd(s, i, "style");
      const raw = s.slice(i, end);
      i = end >= s.length ? s.length : pastEndTag(s, end, 5);
      if (svgDepth === 0) {
        out += `<style>${tuneCss(cleanCss(raw, removed), tuned)}</style>`;
        continue;
      }
      // SVG <style>: judge the CSS the browser will see (entities decoded), then write it back for that context. If
      // the guess is wrong and the browser reads it as raw text, "&amp;" is merely broken CSS, never a hidden fetch.
      const css = decodeEntities(raw);
      if (css === null) removed.remote++;
      else out += `<style>${cleanCss(css, removed).replace(/&/g, "&amp;")}</style>`;
      continue;
    }
    if (DROP_NESTED.has(lower)) {
      removed.elements++;
      if (!parsed.selfClosing) dropping = { name: lower, depth: 1 };
      continue;
    }
    if (DROP_TAG.has(lower)) {
      if (lower === "embed" || lower === "frame" || lower === "link" || lower === "base" || lower === "form") removed.elements++;
      continue;
    }
    if (!TAG_NAME.test(name)) continue;
    const attrs = cleanAttrs(name, parsed.attrs, removed, svgDepth === 0 && lower !== "svg" ? tuned : null);
    if (attrs === null) {
      removed.elements++;
      continue;
    }
    if (lower === "textarea") {
      // RCDATA: its content is text up to </textarea>
      const end = rawEnd(s, i, "textarea");
      out += `<${name}${attrs}>${s.slice(i, end).replace(/</g, "&lt;")}</${name}>`;
      i = end >= s.length ? s.length : pastEndTag(s, end, 8);
      continue;
    }
    out += `<${name}${attrs}${parsed.selfClosing ? " /" : ""}>`;
    if (lower === "svg" && !parsed.selfClosing) svgDepth++;
  }
  return { html: out.trim(), removed, tuned };
}

