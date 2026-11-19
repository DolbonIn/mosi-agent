/**
 * web_read's page reader. From a fetched HTML page (readPage) or from Exa's markdown text of it (readMarkdown):
 * the readable text, contact handles (phone incl. international, email, KakaoTalk ID / open chat, Telegram, LINE,
 * Instagram, WhatsApp, inquiry forms), the same site's contact / about / FAQ links, the content's own links, and the
 * page's main list as items (list mode, items.ts). Links are absolute with the Unicode host (스시자로.site).
 *
 * Regex based on purpose: no DOM, no script ever runs. Everything here is untrusted page data.
 */
import { truncateUtf8 } from "@pickle/agent";
import { Collector, type Contacts, fromHref, pageForms, schemeContact, scrubPlaceholderPhones, textContacts } from "./contacts";
import { attr, clean, cleanLabel, contentRegion, displayHost, displayUrl, htmlText, LINK_SUFFIX, mainText, meaningful, metaContent, safeDecode, sameSite, shortAttributes, stripHash } from "./html";
import { GENERIC, htmlItems, type ItemList, linkGroupItems, type ListItem, markdownItems, MD_LINK, stripImages } from "./items";

export { contactCount, contactStrings, emailValue, phoneValue, type Contact, type Contacts } from "./contacts";
export { decodeBody, displayHost, displayUrl, htmlText } from "./html";
export type { ItemLink, ListItem } from "./items";

export type LinkKind = "contact" | "about" | "faq";

export interface PageLink {
  label: string;
  url: string;
  kind: LinkKind;
}

/** another site the page names as where its data comes from ("출처: 스시자로", "Source: …", "出典: …") */
export interface SourceLink {
  label: string;
  url: string;
}

/** a link in the page's own content (not its menus): a listed shop's or clinic's page, an official site */
export interface ContentLink {
  label: string;
  url: string;
  /** another site */
  external?: true;
}

export interface ReadablePage {
  title: string;
  description: string;
  lang: string;
  /** the readable text (≤ TEXT_MAX_CHARS); the list given as `items` is left out of it, with a marker line */
  text: string;
  contacts: Contacts;
  links: PageLink[];
  pageLinks: ContentLink[];
  /** other sites named as the page's source (≤ 4, one per site; footers count) */
  sources: SourceLink[];
  /** the page's main list (≥ 6 entries), else [] */
  items: ListItem[];
  itemsSource?: ItemList["source"];
  /** the list had more than MAX_ITEMS entries (see ItemList.cut) */
  itemsCut?: true;
  /** the list is the site's menu (see ItemList.menu); not shown, it only weighs the page's read against Exa's copy */
  itemsMenu?: true;
}

/** text kept per page (the cache holds it for `from` paging) */
export const TEXT_MAX_CHARS = 200_000;
const MAX_LINKS = 8;
/** anchors looked at per page */
const MAX_ANCHORS = 5_000;
const MAX_PAGE_LINKS = 12;
const PAGE_LINK_POOL = 400;
const MAX_SOURCES = 4;
/** characters before a link looked at for a source cue */
const CUE_CHARS = 40;

/** a source cue right before a link: "출처: [스시자로](…)", "데이터 제공 …", "Source: …", "出典：…" */
const SOURCE_CUE =
  /(?:출처|자료\s?출처|데이터\s?출처|정보\s?출처|데이터\s?제공|자료\s?제공|정보\s?제공|원문|원본|인용|참고\s?자료|sources?|data\s(?:from|by|source)|adapted\sfrom|出典|出所|引用元?|情報元|参照元?|データ提供|情報提供|提供元)\s{0,3}[:：]?\s{0,3}[[(（「『]?\s{0,3}$/i;
/** a link labelled as the source itself: "출처", "출처: 스시자로", "[Source]", "出典：…" */
const SOURCE_LABEL = /^[[(（「『]?\s{0,3}(?:출처|자료\s?출처|데이터\s?출처|원문|원본|sources?|data\ssource|出典|引用元|情報元|データ提供)\s{0,3}[\])）」』]?\s{0,3}(?:[:：]\s{0,3}|$)/i;

export const listMarker = (n: number): string => `[목록 ${n}개는 items에 있어요]`;

const LINK_RULES: { kind: LinkKind; re: RegExp }[] = [
  { kind: "contact", re: /contact|inquir|enquir|support|customer|qna|\/ask\b|\/cs\b|문의|연락|상담|고객\s?센터|고객지원|오시는\s?길|찾아오시는|お問い?合わ?せ|問合せ|連絡/i },
  { kind: "faq", re: /faq|자주\s?(?:묻는|하는)|질문|q\s?&\s?a|よくある質問|ヘルプ|\/help\b/i },
  { kind: "about", re: /about|company|introduc|\/intro\b|소개|회사|브랜드\s?스토리|운영자|사업자|会社概要|会社案内|私たちについて/i },
];

/** every link of a page goes through here: contacts, follow-up pages, content links, the pool for list fallback */
class LinkSink {
  readonly links: PageLink[] = [];
  readonly sources: SourceLink[] = [];
  readonly pool: ContentLink[] = [];
  readonly content: { label: string; url: URL }[] = [];
  private readonly seen: Set<string>;
  constructor(
    private readonly pageUrl: URL,
    private readonly base: URL,
    private readonly contacts: Collector,
  ) {
    this.seen = new Set([stripHash(pageUrl)]);
  }

  /** `before`: the text right before the link (asked for only for another site's link) */
  add(href: string, label: string, inContent: boolean, before?: () => string): void {
    if (!href || href.startsWith("#")) return;
    if (schemeContact(href, this.contacts, label)) return;
    let u: URL;
    try {
      u = new URL(href, this.base);
    } catch {
      return;
    }
    const hit = fromHref(u, label);
    if (hit) {
      this.contacts.add(hit.kind, hit.c);
      return;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    const same = sameSite(u.hostname, this.pageUrl.hostname);
    if (!same && before && this.sources.length < MAX_SOURCES && this.source(u, label, before)) return;
    if (inContent && meaningful(label) && this.content.length < 3_000) this.content.push({ label, url: u });
    const key = stripHash(u);
    if (this.seen.has(key)) return;
    const rule = same ? LINK_RULES.find((r) => r.re.test(`${label} ${safeDecode(u.pathname)}`)) : undefined;
    if (rule && this.links.length < MAX_LINKS) {
      this.seen.add(key);
      this.links.push({ label: label || safeDecode(u.pathname), url: displayUrl(u), kind: rule.kind });
    } else if (!rule && this.pool.length < PAGE_LINK_POOL && meaningful(label) && !GENERIC.test(label) && inContent && !(same && u.pathname === this.pageUrl.pathname)) {
      // (the same path with other query values is this page re-filtered or re-sorted, not a new page)
      this.seen.add(key);
      const l: ContentLink = { label, url: displayUrl(u) };
      if (!same) l.external = true;
      this.pool.push(l);
    }
  }

  /** another site's link named as the page's source: kept in `sources` (one per site) */
  private source(u: URL, label: string, before: () => string): boolean {
    const byLabel = SOURCE_LABEL.test(label);
    if (!byLabel && !SOURCE_CUE.test(before().slice(-CUE_CHARS))) return false;
    const site = u.hostname.replace(/^www\./, "");
    if (this.sources.some((x) => new URL(x.url).hostname.replace(/^www\./, "") === site)) return true;
    const named = byLabel ? label.replace(SOURCE_LABEL, "").trim() : label;
    this.sources.push({ label: meaningful(named) ? named : displayHost(u.hostname), url: displayUrl(u) });
    this.seen.add(stripHash(u)); // not again among the content links
    return true;
  }

  /** content links not already among the items */
  pageLinks(items: ListItem[]): ContentLink[] {
    const inItems = new Set<string>();
    for (const it of items) {
      for (const url of [it.url, ...(it.links ?? []).map((l) => l.url)]) if (url) inItems.add(pathKey(url));
    }
    return this.pool.filter((l) => !inItems.has(pathKey(l.url))).slice(0, MAX_PAGE_LINKS);
  }
}

function pathKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

function pickList(primary: ItemList | null, sink: LinkSink, pageUrl: URL): ItemList | null {
  if (primary) return primary;
  return linkGroupItems(sink.content, pageUrl);
}

// ───────────────────────────── HTML ─────────────────────────────

/** Read a decoded page. `pageUrl` is the final URL (relative links resolve against it, or against <base href>). */
export function readPage(raw: string, pageUrl: URL, o: { textBytes?: number } = {}): ReadablePage {
  const html = shortAttributes(clean(raw));
  const isHtml = /<(html|head|body|main|article|section|div|p|a|meta|title|table|ul|ol|li|span|h[1-6]|br)\b/i.test(html.slice(0, 20000));
  const contacts = new Collector();
  // placeholder phones ("02-0000-0000(임시번호)") leave the text too: a model copies what it reads
  const cap = (t: string) => {
    const s = scrubPlaceholderPhones(t.length > TEXT_MAX_CHARS * 2 ? t.slice(0, TEXT_MAX_CHARS * 2) : t);
    return o.textBytes ? truncateUtf8(s, o.textBytes, "…") : s.slice(0, TEXT_MAX_CHARS);
  };

  if (!isHtml) {
    const text = html.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n(?: ?\n)+/g, "\n\n").trim();
    textContacts(text, contacts);
    return { title: "", description: "", lang: "", text: cap(text), contacts: contacts.out, links: [], pageLinks: [], sources: [], items: [] };
  }

  let base = pageUrl;
  const baseHref = /<base\b[^<>]{0,2000}>/i.exec(html)?.[0];
  if (baseHref) {
    try {
      const b = new URL(attr(baseHref, "href"), pageUrl);
      if (b.protocol === "https:" || b.protocol === "http:") base = b;
    } catch {
      /* ignore */
    }
  }

  // anchors: tel:/mailto:/messenger links, the same site's follow-up pages and the content's own links
  const sink = new LinkSink(pageUrl, base, contacts);
  const inContent = contentRegion(html);
  // openings only, then a bounded look ahead for the label: an unclosed <a on a hostile page costs ≤ 1500 characters
  const anchor = /<a\b([^<>]{0,2000})>/gi;
  let anchors = 0;
  for (let m = anchor.exec(html); m && anchors < MAX_ANCHORS; m = anchor.exec(html)) {
    anchors++;
    const open = `<a ${m[1] ?? ""}>`;
    const href = attr(open, "href");
    if (!href || href.startsWith("#")) continue;
    const after = m.index + m[0].length;
    const chunk = html.slice(after, after + 1500);
    const end = chunk.search(/<\/a\s*>|<a\b/i);
    const inner = end >= 0 ? chunk.slice(0, end) : chunk.slice(0, 200);
    // "›", "→", an icon: the aria-label / title says what the link is ("야마모토 클리닉 자세히 보기")
    const shown = htmlText(inner).text;
    const label = cleanLabel(meaningful(shown) ? shown : attr(open, "aria-label") || attr(open, "title") || shown).replace(LINK_SUFFIX, "");
    const at = m.index;
    sink.add(href, label, inContent(at), () => htmlText(html.slice(Math.max(0, at - 300), at)).text);
  }
  for (const f of pageForms(html, pageUrl)) contacts.add("forms", f);

  const full = htmlText(html);
  const fullText = clean(full.text);
  textContacts(fullText, contacts);

  const list = pickList(htmlItems(html, base, pageUrl), sink, pageUrl);
  const items = list?.items ?? [];

  // entities decode after the first clean(): invisible characters can come back as &#8203; — clean again
  const title = cleanLabel(clean(full.title || metaContent(html, "og:title")), 200);
  const description = cleanLabel(scrubPlaceholderPhones(clean(metaContent(html, "description") || metaContent(html, "og:description"))), 300);
  const lang = (/<html\b[^<>]{0,2000}\slang\s*=\s*["']?([\w-]{2,12})/i.exec(html)?.[1] ?? "").toLowerCase();
  // the list's own entries are in `items`: the text keeps what is around it (intro, notes) and a marker line
  const body = list?.span ? `${html.slice(0, list.span[0])}<p>${listMarker(items.length)}</p>${html.slice(list.span[1])}` : html;
  let text = clean(mainText(body));
  if (!list && text.length < 80 && fullText.length > text.length) text = fullText;
  const out: ReadablePage = { title, description, lang, text: cap(text), contacts: contacts.out, links: sink.links, pageLinks: sink.pageLinks(items), sources: sink.sources, items };
  if (list) out.itemsSource = list.source;
  if (list?.cut) out.itemsCut = true;
  if (list?.menu) out.itemsMenu = true;
  return out;
}

// ───────────────────────────── markdown (Exa) ─────────────────────────────

/** Read Exa's markdown text of a page (links kept as [label](url)): the same shape as readPage. */
export function readMarkdown(md: string, pageUrl: URL, o: { title?: string; textBytes?: number } = {}): ReadablePage {
  const src = stripImages(clean(md).replace(/\r\n?/g, "\n"));
  const contacts = new Collector();
  const sink = new LinkSink(pageUrl, pageUrl, contacts);
  const link = new RegExp(MD_LINK.source, "g");
  let n = 0;
  for (let m = link.exec(src); m && n < MAX_ANCHORS; m = link.exec(src)) {
    n++;
    const at = m.index;
    sink.add(m[2] ?? "", cleanLabel((m[1] ?? "").replace(/[*_`]/g, "")).replace(LINK_SUFFIX, ""), true, () => src.slice(Math.max(0, at - 120), at).replace(/[*_`#>]/g, ""));
  }
  const list = pickList(markdownItems(src, pageUrl), sink, pageUrl);
  const items = list?.items ?? [];
  const lines = src.split("\n");
  const kept: string[] = [];
  let marked = false;
  for (let i = 0; i < lines.length; i++) {
    if (list?.lines?.has(i)) {
      if (!marked) kept.push(listMarker(items.length));
      marked = true;
      continue;
    }
    kept.push(lines[i]!);
  }
  const plain = (s: string) =>
    s
      .replace(new RegExp(MD_LINK.source, "g"), (_m, label: string) => (meaningful(label) && !GENERIC.test(label.trim()) ? label : ""))
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  textContacts(plain(src), contacts);
  const title = cleanLabel(clean(o.title ?? "") || (/^\s{0,3}#\s+(.+)$/m.exec(src)?.[1] ?? ""), 200);
  let text = plain(kept.join("\n"));
  if (title && text.startsWith(title)) text = text.slice(title.length).trimStart();
  text = scrubPlaceholderPhones(text.length > TEXT_MAX_CHARS * 2 ? text.slice(0, TEXT_MAX_CHARS * 2) : text);
  text = o.textBytes ? truncateUtf8(text, o.textBytes, "…") : text.slice(0, TEXT_MAX_CHARS);
  const out: ReadablePage = { title, description: "", lang: "", text, contacts: contacts.out, links: sink.links, pageLinks: sink.pageLinks(items), sources: sink.sources, items };
  if (list) out.itemsSource = list.source;
  if (list?.cut) out.itemsCut = true;
  return out;
}
