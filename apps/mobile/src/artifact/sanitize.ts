/**
 * HTML artifact sanitizer: the model's HTML/CSS fragment → `{ css, body, text }` ready for the sandboxed frame
 * (srcdoc.ts). It is the second wall, not the only one. The frame is `sandbox="allow-scripts"` with a CSP of
 * `default-src 'none'` and a nonce, so a script, handler or remote load that slipped through still could not run or
 * fetch. Cleaning first keeps the frame quiet (no CSP violations in the console) and closes what CSP does not
 * cover: navigation (meta refresh, base, forms) and focus or scroll stealing (autofocus).
 *
 * Removed: script and the raw-text elements a reparse could turn into markup (xmp, noembed, noframes, plaintext,
 * noscript), iframe/frame/object/embed/applet/portal, link/base/meta/title, form (its children stay), media elements
 * (no media source is allowed). Also removed: every on* attribute, srcdoc/formaction/action/ping/autofocus/target,
 * and any URL that is not https on a link (<a>, <area>; the only links the app opens) or data:image on an image (an
 * svg reference may also be a #fragment). Remote images are
 * dropped (img-src is data: only). CSS loses @import, every url() that is not data:image or data:font (checked after
 * its escapes are decoded), image-set() and src() (they take bare-string URLs), expression(), behavior and
 * -moz-binding. vh units become the app's viewport height: inside a frame sized to its content, a `100vh` block would
 * grow forever. `</style` is escaped so CSS cannot close its element. A table gets a horizontal scroll box unless it
 * already sits alone in one.
 *
 * The output is parsed again until nothing more is removed (at most 3 passes), so a serialise → reparse difference
 * (mXSS) cannot bring back what was taken out.
 */

export interface CleanHtml {
  /** every <style> of the input, cleaned, in order */
  css: string;
  /** the cleaned body markup */
  body: string;
  /** the visible text (copy, share, previews, screen-reader fallback) */
  text: string;
  /** how many elements/attributes/urls were removed (QA) */
  removed: number;
}

const DROP = new Set([
  "script",
  "noscript",
  "xmp",
  "noembed",
  "noframes",
  "plaintext",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "param",
  "link",
  "base",
  "meta",
  "title",
  "audio",
  "video",
  "source",
  "track",
  "set",
  "template",
]);
const UNWRAP = new Set(["form"]);
const DROP_ATTR = new Set(["srcdoc", "formaction", "action", "ping", "autofocus", "target", "http-equiv", "nonce", "integrity", "popovertarget", "contenteditable"]);
const LINK_OK = /^https:\/\//i;
const IMG_OK = /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;
const URL_ATTRS = ["href", "xlink:href", "src", "srcset", "poster", "background", "data", "cite", "longdesc", "lowsrc", "dynsrc", "manifest", "codebase", "usemap"];

/** CSS text (a stylesheet or a style attribute) without anything that loads, runs or breaks out */
export function cleanCss(css: string): string {
  let out = css
    // escapes first: `\75 rl(` is `url(` to the CSS parser, so the checks below must see it decoded
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (m, h: string) => {
      const c = String.fromCodePoint(Math.min(parseInt(h, 16) || 0xfffd, 0x10ffff));
      return /[a-z0-9(:/@.-]/i.test(c) ? c : m;
    })
    .replace(/\\([g-z])/gi, "$1")
    .replace(/@import[^;]*;?/gi, "")
    // image-set() and src() take a bare string as a URL
    .replace(/(-webkit-)?image-set\s*\(|\bsrc\s*\(/gi, "none(")
    .replace(/expression\s*\(/gi, "none(")
    .replace(/behavior\s*:/gi, "x-behavior:")
    .replace(/-moz-binding\s*:/gi, "x-binding:")
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, q: string, u: string) => (/^data:(image|font)\//i.test(u.trim()) ? `url(${q}${u}${q})` : "none"))
    .replace(/(-?\d*\.?\d+)\s*(s|d|l)?vh\b/gi, (_m, n: string) => `calc(var(--m-vh) * ${n})`);
  out = out.replace(/<\/(style)/gi, "<\\/$1").replace(/<!--|-->/g, "");
  return out;
}

function cleanAttrs(el: Element): number {
  let n = 0;
  const tag = el.localName;
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on") || name.startsWith("data-m-on") || DROP_ATTR.has(name)) {
      el.removeAttribute(attr.name);
      n++;
      continue;
    }
    if (name === "style") {
      const c = cleanCss(attr.value);
      if (c !== attr.value) el.setAttribute("style", c);
      continue;
    }
    if (!URL_ATTRS.includes(name)) continue;
    const v = attr.value.trim();
    let ok = false;
    if ((name === "href" || name === "xlink:href") && (tag === "a" || tag === "area")) ok = LINK_OK.test(v);
    else if (name === "href" || name === "xlink:href") ok = v.startsWith("#") || IMG_OK.test(v); // svg use/image/pattern
    else if (name === "src") ok = IMG_OK.test(v);
    else if (name === "srcset") ok = v.split(",").every((part) => IMG_OK.test(part.trim()));
    if (!ok) {
      el.removeAttribute(attr.name);
      n++;
    }
  }
  return n;
}

function walk(root: Element): number {
  let n = 0;
  for (const el of [...root.querySelectorAll("*")]) {
    if (!el.isConnected) continue;
    const tag = el.localName;
    if (DROP.has(tag)) {
      el.remove();
      n++;
      continue;
    }
    if ((tag === "animate" || tag === "animatetransform" || tag === "animatemotion") && /href/i.test(el.getAttribute("attributeName") ?? "")) {
      el.remove();
      n++;
      continue;
    }
    if (UNWRAP.has(tag)) {
      const div = el.ownerDocument.createElement("div");
      for (const a of [...el.attributes]) if (a.name === "class" || a.name === "style" || a.name === "id") div.setAttribute(a.name, a.value);
      while (el.firstChild) div.appendChild(el.firstChild);
      el.replaceWith(div);
      n++;
      n += cleanAttrs(div);
      continue;
    }
    n += cleanAttrs(el);
    // an image with nothing it may load says what it was (its alt), or goes
    if (tag === "img" && !el.getAttribute("src")) {
      const alt = el.getAttribute("alt")?.trim();
      if (alt) {
        const span = el.ownerDocument.createElement("span");
        span.className = "m-noimg";
        span.textContent = alt;
        el.replaceWith(span);
      } else el.remove();
    }
  }
  for (const t of [...root.querySelectorAll("table")]) {
    const p = t.parentElement;
    // already in a box of its own (the guide's .scroll { overflow-x: auto }, or ours): leave it
    if (p && p !== root && p.children.length === 1 && (p.classList.contains("m-scroll") || /scroll/i.test(p.className) || /overflow/i.test(p.getAttribute("style") ?? ""))) continue;
    const box = t.ownerDocument.createElement("div");
    box.className = "m-scroll";
    t.replaceWith(box);
    box.appendChild(t);
  }
  return n;
}

/**
 * Chrome checks the page's CSP when an on* attribute is parsed, even into an inert DOMParser document: every handler
 * the model wrote would print a CSP violation in the app's console (nothing runs: the document is inert). So handler
 * attributes are renamed inside tags before parsing (`onerror=` → `data-m-onerror=`); the DOM pass below still removes
 * every on* and data-m-on* attribute, so this rename is only about the noise, never the guard.
 */
const TAG = /<[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>?/g;
const HANDLER = /("[^"]*"|'[^']*')(on[a-z0-9_-]*\s*=)?|([\s/])(on[a-z0-9_-]*\s*=)/gi; // quoted values are left as they are
const defuse = (html: string) =>
  html.replace(TAG, (tag) => tag.replace(HANDLER, (_m, q?: string, afterQ?: string, pre?: string, on?: string) => (q !== undefined ? q + (afterQ ? `data-m-${afterQ}` : "") : `${pre}data-m-${on}`)));

function pass(input: string, parser: DOMParser): CleanHtml {
  const doc = parser.parseFromString(defuse(input), "text/html");
  const css: string[] = [];
  let removed = 0;
  for (const s of [...doc.querySelectorAll("style")]) {
    css.push(cleanCss(s.textContent ?? ""));
    s.remove();
  }
  // head content other than style never renders: what matters is the body
  removed += walk(doc.body);
  const text = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
  return { css: css.join("\n"), body: doc.body.innerHTML, text, removed };
}

export function sanitizeHtml(input: string): CleanHtml {
  const parser = new DOMParser();
  let out = pass(input, parser);
  let total = out.removed;
  for (let i = 0; i < 2; i++) {
    // reparse the serialised result together with its styles: nothing may change any more
    const again = pass(`<style>${out.css}</style>${out.body}`, parser);
    if (again.removed === 0 && again.body === out.body) break;
    total += again.removed;
    out = again;
  }
  return { ...out, removed: total };
}

/** UTF-8 size of the fragment (the 150 KB limit is in bytes) */
export const htmlBytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * In a sheet whose title bar already names the page, a first heading that says the same is said once: removed from
 * the cleaned body (the inline card keeps it, since the card has no title of its own).
 */
export function withoutLeadingTitle(body: string, title: string): string {
  const want = title.replace(/\s+/g, "");
  if (!want) return body;
  const doc = new DOMParser().parseFromString(`<body>${body}`, "text/html");
  // the page's first heading, also when it opens a wrapper (<section><h2>…), at most three levels down
  let first = doc.body.firstElementChild;
  for (let i = 0; first && i < 3 && !/^h[1-3]$/.test(first.localName); i++) {
    if (!/^(section|article|header|div|main|hgroup)$/.test(first.localName)) return body;
    first = first.firstElementChild;
  }
  if (!first || !/^h[1-3]$/.test(first.localName) || (first.textContent ?? "").replace(/\s+/g, "") !== want) return body;
  first.remove();
  return doc.body.innerHTML;
}
