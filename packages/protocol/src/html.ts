/**
 * Shared helpers for "html" artifacts (see Artifact.content): the server stores a cleaned fragment, the card and the
 * archive list show its text. Pure string work, no DOM: the same on the server, in the app and in tests.
 */

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", bull: "•", hellip: "…", mdash: "—",
  ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", times: "×", copy: "©", reg: "®", trade: "™", deg: "°",
  rarr: "→", larr: "←", uarr: "↑", darr: "↓", hearts: "♥", star: "☆", check: "✓", plus: "+", minus: "−",
};

function decode(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{0,31}));?/g, (m, dec, hex, name) => {
    if (dec || hex) {
      const cp = dec ? Number(dec) : parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : " ";
    }
    const v = NAMED[name] ?? NAMED[name.toLowerCase()];
    return v ?? (m.endsWith(";") ? " " : m);
  });
}

/**
 * The visible text of an HTML fragment, one line per block: no <style>/<script>/<title>/<template>/<noscript> content,
 * no comments, block ends and <br> as line breaks, a space between inline elements that touch ("<b>64</b><span>개추"
 * → "64 개추"; "</b>가" stays joined), entities decoded, whitespace folded within lines. For previews, sharing, search.
 */
export function htmlText(html: string): string {
  const t = html
    .replace(/<(style|script|title|template|noscript|textarea)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/(<\/[a-zA-Z][^>]*>)(?=<[a-zA-Z])/g, "$1 ")
    .replace(/<(?:br|hr|\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|thead|tbody|section|article|header|footer|figure|figcaption|dl|dt|dd|blockquote|details|summary|nav|aside|main))\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decode(t)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const NAV_CLASS = /\b(?:tabs?|tab-?bar|nav|menu|breadcrumbs?|filters?|chips)\b/i;

/**
 * Tabs and navigation, for the preview: <nav>, role="tablist", a list or a div (without divs inside) whose class says
 * tabs/nav/menu/filters/chips, and a list of 4+ items of at most 10 characters each.
 */
function withoutNav(html: string): string {
  const classOf = (attrs: string) => /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)?.slice(1).find((c) => c !== undefined) ?? "";
  return html
    .replace(/<nav\b[\s\S]*?(?:<\/nav\s*>|$)/gi, " ")
    .replace(/<(div|ul|ol)\b[^>]*\brole\s*=\s*["']?tablist\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<div\b([^>]*)>((?:(?!<div\b)[\s\S])*?)<\/div\s*>/gi, (all, attrs: string) => (NAV_CLASS.test(classOf(attrs)) ? " " : all))
    .replace(/<(ul|ol)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, (list, _tag: string, attrs: string, body: string) => {
      if (NAV_CLASS.test(classOf(attrs))) return " ";
      const items = body.split(/<li\b[^>]*>/i).slice(1).map((li) => htmlText(li));
      return items.length >= 4 && items.every((t) => t.length <= 10) ? " " : list;
    });
}

/**
 * The preview line of an html artifact: its text lines joined with " · ", without a first line that only repeats the
 * title, and without tabs and navigation (unless little else is left: a card that is one short list keeps it). At most
 * `max` characters, cut at a word where one is near.
 */
export function htmlPreview(html: string, title = "", max = 140): string {
  const lines = previewLines(withoutNav(html), title);
  const t = lines.join(" · ").length >= 30 ? lines.join(" · ") : previewLines(html, title).join(" · ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s·]+$/, "")}…`;
}

function previewLines(html: string, title: string): string[] {
  const lines = htmlText(html).split("\n").filter(Boolean);
  const head = title.trim();
  if (head && lines[0]?.startsWith(head)) {
    const rest = lines[0].slice(head.length).replace(/^[\s:·|—-]+/, "");
    if (rest) lines[0] = rest;
    else lines.shift();
  }
  return lines;
}
