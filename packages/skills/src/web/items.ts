/**
 * web_read's list mode: the repeated entries of a directory, ranking, price comparison or result page (cards, rows,
 * list entries), each with its name, link, one line of text, its own other links and contact handles — so a page
 * that lists 65 clinics comes back as 65 items, not as a cut-off wall of text.
 *
 * - HTML: one linear pass tracks the element nesting (a stack, forgiving of unclosed tags). Elements with the same
 *   tag + classes under the same parent and grandparent shape form a group (siblings with an extra class, such as
 *   the entries behind 'show more', also with the plain ones); the best group with ≥ 6 members (members × text per
 *   member × share with a link; menus count less) is the list — or one of exactly the count the page's title states.
 * - Markdown (Exa's page text): list or table lines with a link, grouped by the link's path prefix.
 * - Fallback: ≥ 6 links of the same site in the content that share a path prefix (/clinic/…).
 *
 * Bounded everywhere (element, group and member caps, bounded regexes): a hostile page costs linear time.
 */
import { addressOnly, AREA_CHARS, areaIn, areaValue, isAreaHeader } from "./area";
import { Collector, contactStrings, fromHref, placeholderPhone, schemeContact, scrubPlaceholderPhones, textContacts } from "./contacts";
import { attr, CHROME, cleanLabel, displayHost, displayUrl, htmlText, LINK_SUFFIX, meaningful, sameSite, SKIP, skipTo, TOKEN_SOURCE } from "./html";

export interface ItemLink {
  label: string;
  url: string;
}

export interface ListItem {
  name: string;
  /**
   * the name's core, to see the same place across pages and sites: NFKC, lower case, without separators and generic
   * kind words (클리닉 / 의원 / 병원 / クリニック / 医院 / 病院 / clinic / hospital …; 내과 · 피부과 stay): "미라이 메디컬 클리닉"
   * and "미라이 클리닉" → "미라이", "KOYOMI CLINIC" → "koyomi". Equal keys are equal names, not yet the same place (one
   * name in two cities): the area or `tel` decides. Both scripts stay ("고토 의원 後藤医院" → "고토後藤", "고토 의원 五藤医院"
   * → "고토五藤": two clinics); a Korean and a Japanese name meet only through `tel`.
   */
  key: string;
  /**
   * the entry's first phone as national digits (+81 3-6233-9010 → 0362339010): the same tel is the same place.
   * Placeholder numbers (02-0000-0000, 010-1234-5678, one marked 임시번호 / 예시 / sample) are never a tel or a contact.
   */
  tel?: string;
  /**
   * the entry's area as the page writes it, not translated ("大阪市中央区", "도쿄 신주쿠산초메", "渋谷区"): from a
   * location element, a table's area column, "지역: …" / "所在地：…" or an address in its text (cut to its area part)
   */
  area?: string;
  /** absolute, Unicode host (https://스시자로.site/clinic/…) */
  url?: string;
  /** the item's site, when it is not the page's */
  domain?: string;
  /** the entry's own text in one line (tags, area, price …), without the name */
  text?: string;
  /** the entry's other links (an official site, a booking page) */
  links?: ItemLink[];
  /** phones, emails, messenger handles in the entry */
  contacts?: string[];
}

export interface ItemList {
  items: ListItem[];
  source: "html" | "markdown" | "links";
  /** HTML: where the list sits (start of its first entry, end of its last) */
  span?: [number, number];
  /** markdown: the lines the entries came from */
  lines?: Set<number>;
  /** the page lists more distinct entries than MAX_ITEMS: the rest are neither in `items` nor in the text */
  cut?: true;
  /** HTML: the list is the site's menu (most entries in its header / nav / footer): no list of places */
  menu?: true;
}

export const MIN_ITEMS = 6;
/**
 * entries kept per page; web_read pages through them from its cache (itemsFrom, no new request). A real directory
 * lists 430 clinics on one page; past this a page is a site-wide index, and the list says it was cut.
 */
export const MAX_ITEMS = 1_000;
const MAX_ELEMENTS = 200_000;
const MAX_GROUPS = 20_000;
const MAX_MEMBERS = 2_000;
const MAX_DEPTH = 256;
const NAME_CHARS = 60;
const TEXT_CHARS = 110;
const ITEM_LINKS = 3;
const ITEM_CONTACTS = 4;
/** blocks read when looking for entries drawn differently inside a list, and the bytes they may span in all */
const EXTRA_LOOKS = 1_000;
const EXTRA_BYTES = 1_500_000;
/** blocks considered for that (smallest first) */
const EXTRA_CANDIDATES = 50_000;
/** characters of an aria-label / title looked at */
const ARIA_CHARS = 300;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen"]);
/** an opening one of these closes an open one of the same tag (<li>a<li>b) */
const IMPLIED = new Set(["li", "tr", "td", "th", "dt", "dd", "option", "p"]);
/** what an entry can be (paragraphs, spans and cells are parts of one) */
const CONTAINER = new Set(["li", "tr", "article", "div", "section", "a", "dl", "dt", "figure", "button", "details", "tbody"]);
/** a link inside running text or inside an entry is not an entry of its own (a card that is one big <a> is) */
const TEXT_PARENT = new Set(["p", "span", "em", "strong", "b", "i", "u", "small", "mark", "font", "label", "cite", "blockquote", "figcaption", "li", "dd", "dt", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"]);
const STATE_CLASS = /^(?:active|on|off|selected|current|open|opened|show|shown|hide|hidden|first|last|odd|even|clearfix|cf|new|hot|best|pc|mo|mobile|sale|soldout|disabled|is-.*|has-.*|js-.*|swiper-slide-.*|slick-.*|aos-.*|animate.*|fade.*)$/;
const NAME_CLASS = /(?:^|[-_])(?:name|nm|title|tit|ttl|heading|subject|store|shop|clinic|hospital|hosp|place|company|brand|vendor|seller)(?:$|[-_])/;
/** link labels that say nothing about the entry */
export const GENERIC =
  /^(?:자세히(?:\s?보기)?|더\s?보기|바로\s?가기|상세(?:\s?보기)?|보기|예약(?:하기)?|문의(?:하기)?|홈페이지|공식\s?(?:사이트|홈페이지)|사이트|링크|지도(?:에서\s?보기)?|more|details?|view|link|website|visit|official (?:site|website)|homepage|book(?: now)?|詳細(?:はこちら)?|詳しく|予約|公式(?:\s?(?:サイト|ホームページ|HP|ページ|LINE))?(?:はこちら|を見る|へ)?|(?:web|ウェブ)?サイト(?:はこちら|を見る|へ)?|ホームページ|HP|こちら|›|»|>|→|＞)$/i;
/** a link whose label is its address ("https://dioclinic.jp/clinic/osakaeki/", "www.x.jp", "light-clinic.co.jp"): no name */
const URL_LABEL = /^(?:https?:\/\/\S{1,2000}|www\.\S{1,2000}|[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,4}\.(?:com|net|org|info|biz|jp|kr|clinic|io|me)(?:\/\S{0,2000})?)$/i;
/**
 * a button's or a menu's words and nothing else ("지도보기", "카카오맵 →", "모두지도", "アクセス", "地図を開く ↗", "LINEで相談",
 * "📞 전화번호"): what its link does, not a name. A word left over keeps it ("アクセスクリニック", "전화국", "Book Cafe")
 */
const BUTTON_WORD = /予約|詳細|詳しく|見る|みる|開く|サイト|ページ|アクセス|地図|マップ|一覧|問い?合わ?せ|相談|電話|メール|こちら|예약|자세히|상세|보기|하기|가기|사이트|페이지|지도|맵|길\s?찾기|오시는\s?길|문의|상담|전화|연락처|\b(?:book(?:ing)?|reserv[a-z]*|details?|website|site\s?map|contact|maps?)\b/iu;
const BUTTON_REST =
  /ご?予約|WEB|ウェブ|ネット|LINE|ライン|詳細|詳しく|公式|サイト|ページ|ホーム|HP|アクセス|地図|(?:Google|グーグル)?\s?マップ|一覧|お?問い?合わ?せ|ご?相談|電話(?:番号)?|メール|こちら|もっと|続き|トップ|見る|みる|開く|する|確認|を|で|から|へ|は|の|예약|자세히|상세|더|공식|사이트맵|사이트|페이지|홈페이지|홈|(?:카카오|네이버|구글|다음|모두|티|애플)?\s?(?:지도|맵)|네이버\s?예약|길\s?찾기|(?:찾아)?오시는\s?길|위치|문의|상담|대표|전화|번호|연락처|하기|보기|가기|바로|에서|으로|\b(?:book(?:ing)?|reserv[a-z]*|details?|website|site\s?map|contact|us|more|now|here|click|see|go|to|on|in|the|online|official|read|view|open|(?:google|apple|naver|kakao)?\s?maps?)\b/giu;
/** `label` is a button's words alone; `loose`: also words that only go with a button's ("公式 ▶", "LINE", "もっと") */
export function buttonLabel(label: string, loose = false): boolean {
  const n = label.normalize("NFKC");
  return (loose || BUTTON_WORD.test(n)) && !!n.replace(/[\s\p{P}\p{S}\d]/gu, "") && !n.replace(BUTTON_REST, "").replace(/[\s\p{P}\p{S}\d]/gu, "");
}
/** a label that names nothing: a generic word or an address */
const plainLabel = (label: string) => GENERIC.test(label) || URL_LABEL.test(label);
/** a link's or a heading's label that names nothing: also a button's words ("지도보기"; a table's row "電話番号" is a row's name) */
const linkLabel = (label: string) => plainLabel(label) || buttonLabel(label);
/** a phone's or a mail's link: its label is no name */
const CONTACT_HREF = /^\s{0,8}(?:tel|mailto|sms|callto):/i;
/** a button's words that do something ("지도보기", "地図を開く"), not a field's label ("電話番号", "アクセス") */
const BUTTON_ACT = /見る|みる|開く|보기|하기|가기|찾기|\b(?:view|open|see|click)\b/iu;
/** words that say nothing about the entry: a generic link word or a button's words */
const nothing = (label: string) => GENERIC.test(label) || buttonLabel(label);

function classSig(open: string): string {
  const m = /\sclass\s*=\s*(?:"([^"<>]{0,400})"|'([^'<>]{0,400})'|([^\s"'<>]{1,200}))/i.exec(open);
  if (!m) return "";
  const raw = (m[1] ?? m[2] ?? m[3] ?? "").toLowerCase().split(/\s+/);
  const keep = new Set<string>();
  for (const c of raw) {
    if (!c || STATE_CLASS.test(c)) continue;
    const t = c.replace(/\d+/g, "");
    if (t.replace(/[-_]/g, "")) keep.add(t);
  }
  return [...keep].sort().slice(0, 3).join(".");
}

interface Open {
  tag: string;
  parentTag: string;
  full: string;
  parent: string;
  grand: string;
  start: number;
  /** where the parent element starts (-1: none) */
  parentAt: number;
  depth: number;
  chrome: boolean;
}

interface Member {
  start: number;
  end: number;
  depth: number;
  chrome: boolean;
  /** where the parent element starts: members with the same one are siblings */
  parentAt: number;
}

interface Group {
  tag: string;
  members: Member[];
  /** parent and grandparent shape plus tag, without the element's own classes */
  base: string;
  classes: string[];
}

/** groups of same-shaped sibling-like elements: key → members (outermost first, in page order) */
function shapeGroups(html: string): Map<string, Group> {
  const groups = new Map<string, Group>();
  const stack: Open[] = [];
  const token = new RegExp(TOKEN_SOURCE, "g");
  let elements = 0;
  const close = (el: Open, end: number) => {
    if (!CONTAINER.has(el.tag) || end - el.start < 24) return;
    if (el.tag === "a" && TEXT_PARENT.has(el.parentTag)) return;
    const key = `${el.grand}>${el.parent}>${el.full}`;
    let g = groups.get(key);
    if (!g) {
      if (groups.size >= MAX_GROUPS) return;
      groups.set(key, (g = { tag: el.tag, members: [], base: `${el.grand}>${el.parent}>${el.tag}`, classes: el.full.split(".").slice(1) }));
    }
    if (g.members.length < MAX_MEMBERS) g.members.push({ start: el.start, end, depth: el.depth, chrome: el.chrome, parentAt: el.parentAt });
  };
  for (let m = token.exec(html); m; m = token.exec(html)) {
    let pos = m.index + m[0].length;
    if (m[0] === "<!--") {
      const end = html.indexOf("-->", pos);
      pos = end < 0 ? html.length : end + 3;
    } else if (m[2]) {
      const name = m[2].toLowerCase();
      if (m[1] === "/") {
        for (let i = stack.length - 1; i >= Math.max(0, stack.length - 12); i--) {
          if (stack[i]!.tag !== name) continue;
          while (stack.length > i) close(stack.pop()!, pos);
          break;
        }
      } else if (SKIP.has(name) && !m[0].endsWith("/>")) {
        pos = skipTo(html, name, pos);
      } else if (!VOID.has(name) && !m[0].endsWith("/>")) {
        if (++elements > MAX_ELEMENTS) break;
        if (IMPLIED.has(name) && stack.length && stack[stack.length - 1]!.tag === name) close(stack.pop()!, m.index);
        if (stack.length < MAX_DEPTH) {
          const top = stack[stack.length - 1];
          const sig = classSig(m[0]);
          stack.push({
            tag: name,
            parentTag: top?.tag ?? "",
            full: sig ? `${name}.${sig}` : name,
            parent: top?.full ?? "",
            grand: top?.parent ?? "",
            start: m.index,
            parentAt: top?.start ?? -1,
            depth: stack.length,
            chrome: (top?.chrome ?? false) || CHROME.has(name),
          });
        }
      }
    }
    token.lastIndex = pos;
  }
  while (stack.length) close(stack.pop()!, html.length);
  withModifiers(groups);
  return groups;
}

/**
 * Siblings of one list where some carry an extra class ("clsec" and "clsec fold" for the entries behind 'show more',
 * <tr> and <tr class="fold">): the plain group and its modified ones under the same parent element also form one
 * group together. The groups themselves stay (the scoring picks), at most MAX_MERGES such unions.
 */
const MAX_MERGES = 200;
/** pairs of groups compared, members looked at: a page of thousands of class variants costs no more */
const MERGE_LOOKS = 200_000;
function withModifiers(groups: Map<string, Group>): void {
  const byBase = new Map<string, string[]>();
  for (const [k, g] of groups) {
    const ks = byBase.get(g.base);
    if (ks) ks.push(k);
    else byBase.set(g.base, [k]);
  }
  let merges = 0;
  let looks = 0;
  for (const ks of byBase.values()) {
    if (ks.length < 2) continue;
    for (const k of ks) {
      if (merges >= MAX_MERGES || looks >= MERGE_LOOKS || groups.size >= MAX_GROUPS) return;
      const g = groups.get(k)!;
      // a bare <div> or <section> is any block: only rows and list entries without a class of their own merge
      if (!g.classes.length && g.tag !== "tr" && g.tag !== "li") continue;
      looks += g.members.length;
      const parents = new Set(g.members.map((m) => m.parentAt));
      const extra: Member[] = [];
      for (const k2 of ks) {
        if (++looks >= MERGE_LOOKS) return;
        const o = groups.get(k2)!;
        if (o === g || o.classes.length <= g.classes.length || !g.classes.every((c) => o.classes.includes(c))) continue;
        looks += o.members.length;
        if (o.members.some((m) => parents.has(m.parentAt))) extra.push(...o.members);
      }
      if (!extra.length) continue;
      merges++;
      groups.set(`${k}+`, { ...g, members: [...g.members, ...extra].slice(0, MAX_MEMBERS) });
    }
  }
}

/** keep the outermost members (a group can nest in itself: div.box > div.box) */
function outermost(ms: Member[]): Member[] {
  const sorted = [...ms].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Member[] = [];
  let end = -1;
  for (const m of sorted) {
    if (m.start < end) continue;
    out.push(m);
    end = m.end;
  }
  return out;
}

const HAS_LINK = /<a\b[^<>]{0,2000}?\shref\s*=|\sdata-(?:href|url|link)\s*=/i;
const SLICE_MAX = 30_000;

interface Candidate {
  members: Member[];
  score: number;
  depth: number;
  tag: string;
  chrome: boolean;
}

function scoreGroup(html: string, tag: string, members: Member[], min = MIN_ITEMS): Candidate | null {
  const ms = outermost(members);
  if (ms.length < min) return null;
  let withText = 0;
  let withLink = 0;
  let total = 0;
  const sample = ms.length > 120 ? ms.filter((_, i) => i % Math.ceil(ms.length / 120) === 0) : ms;
  for (const m of sample) {
    const slice = html.slice(m.start, Math.min(m.end, m.start + SLICE_MAX));
    const t = htmlText(slice).text.replace(/\s+/g, " ").trim();
    if (meaningful(t)) withText++;
    total += Math.min(t.length, 400);
    if (HAS_LINK.test(slice)) withLink++;
  }
  const n = sample.length;
  const avg = total / n;
  const linkFrac = withLink / n;
  if (withText / n < 0.6 || avg < 4 || avg > 2500) return null;
  // entries without links: only table rows (a price or phone table); a bullet list or paragraphs stay text
  if (linkFrac < 0.5 && tag !== "tr") return null;
  const chrome = ms.filter((m) => m.chrome).length / ms.length > 0.5;
  const score = ms.length * (withText / n) * Math.min(avg, 160) * (0.25 + linkFrac) * (chrome ? 0.15 : 1);
  return { members: ms, score, depth: Math.min(...ms.map((m) => m.depth)), tag, chrome };
}

/** "一覧19院", "서울 피부과 65곳", "12 clinics": how many entries the page says it lists */
const STATED = /(?:^|[^\d.,])(\d{1,4})\s{0,2}(?:院|곳|군데|개소|件|軒|店舗|施設|clinics?|hospitals?|places|locations|stores|shops)(?![a-z])/iu;
/** a group this much below the best still wins when it has exactly the stated number of entries */
const STATED_SHARE = 0.25;
/** groups of the stated size outside the 40 biggest that are scored: how many, and their bytes in all */
const STATED_GROUPS = 60;
const STATED_BYTES = 1_500_000;

/** the elements a member opens with below its own tag, three deep while nothing else comes first: tag and classes */
function insideShape(html: string, m: Member): { tag: string; cls: string[] }[] {
  let at = m.start;
  const shape: { tag: string; cls: string[] }[] = [];
  const open = /^(?:\s|<!--[\s\S]{0,500}?-->){0,20}<([a-z][\w-]{0,30})\b([^<>]{0,2000})>/i;
  for (let level = 0; level < 4 && at < m.end; level++) {
    const r = open.exec(html.slice(at, Math.min(m.end, at + 3_000)));
    if (!r) break;
    // digits left out ("pp-P3", "rank-1")
    const cls = (/\bclass\s{0,3}=\s{0,3}["']([^"']{0,300})["']/i.exec(r[2]!)?.[1] ?? "").replace(/\d+/g, "").split(/\s+/).filter(Boolean);
    if (level) shape.push({ tag: r[1]!.toLowerCase(), cls });
    at += r[0].length;
  }
  return shape;
}

/**
 * one list's entries are drawn alike inside: level by level the same tag, and a class in common (or none on either) —
 * one wrapper drawn around different things (a fold around the tips, another around the sources) is not a list
 */
function drawnAlike(html: string, ms: Member[]): boolean {
  const first = insideShape(html, ms[0]!);
  for (const m of ms.slice(1)) {
    const s = insideShape(html, m);
    if (s.length !== first.length) return false;
    for (const [k, x] of s.entries()) {
      const f = first[k]!;
      if (x.tag !== f.tag || ((x.cls.length || f.cls.length) && !x.cls.some((c) => f.cls.includes(c)))) return false;
    }
  }
  return true;
}

/** the count in the page's <title> or first <h1> (2…MAX_ITEMS), or 0 */
export function statedCount(html: string): number {
  const texts: string[] = [];
  const title = /<title\b[^<>]{0,500}>([^<]{0,500})/i.exec(html.slice(0, 200_000));
  if (title) texts.push(htmlText(title[1]!).text);
  const h1 = html.search(/<h1\b/i);
  if (h1 >= 0) {
    const chunk = html.slice(h1, h1 + 3_000);
    const end = chunk.search(/<\/h1\s{0,3}>/i);
    if (end > 0) texts.push(htmlText(chunk.slice(0, end).replace(/^<h1\b[^<>]{0,2000}>/i, "")).text);
  }
  for (const t of texts) {
    const n = statedIn(t);
    if (n) return n;
  }
  return 0;
}

/** the count a title says it lists ("… 요금 2곳 비교"; 2…MAX_ITEMS), or 0 */
export function statedIn(title: string): number {
  const n = Number(STATED.exec(title.slice(0, 500).replace(/\s+/g, " "))?.[1] ?? 0);
  return n >= 2 && n <= MAX_ITEMS ? n : 0;
}

/** query keys that only preview a draft, track a visit or ask for the AMP copy: the page with them is the same page */
const SELF_PARAM = /^(?:preview(?:_\w{1,40})?|_thumbnail_id|utm_\w{1,40}|amp)$/i;

/** the page a link opens, without its fragment, its www., its AMP path or query keys of SELF_PARAM */
function pageOf(u: URL): string {
  const query = u.search ? [...u.searchParams].filter(([k]) => !SELF_PARAM.test(k)).map(([k, v]) => `${k}=${v}`).sort().join("&") : "";
  return `${u.hostname.replace(/^www\./i, "")}${u.pathname.replace(/\/amp\/?$/i, "/").replace(/\/+$/, "")}?${query}`;
}

/**
 * a link to this same page: a jump inside it (#fragment), a draft's preview of it ("?preview_id=…&preview=true", the
 * address an article links its own clinic rows to), its tracked ("?utm_source=…") or AMP copy ("/amp/", "?amp=1"). Not
 * an entry's own page: an entry linked only so has no link
 */
let ownPage = { href: "", page: "" };
function samePage(u: URL, pageUrl: URL): boolean {
  if (ownPage.href !== pageUrl.href) ownPage = { href: pageUrl.href, page: pageOf(pageUrl) };
  return pageOf(u) === ownPage.page;
}

interface Anchor {
  href: string;
  label: string;
  aria: string;
}

function anchorsIn(slice: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<(a|button)\b([^<>]{0,2000})>/gi;
  for (let m = re.exec(slice); m && out.length < 30; m = re.exec(slice)) {
    const open = m[0];
    const isA = m[1]!.toLowerCase() === "a";
    const href = isA ? attr(open, "href") : "";
    const data = attr(open, "data-href") || attr(open, "data-url") || attr(open, "data-link");
    const target = href || data;
    const after = m.index + m[0].length;
    const chunk = slice.slice(after, after + 1500);
    const end = chunk.search(isA ? /<\/a\s*>|<a\b/i : /<\/button\s*>/i);
    const shown = htmlText(end >= 0 ? chunk.slice(0, end) : chunk.slice(0, 200)).text.replace(/\s+/g, " ").trim();
    const aria = cleanLabel(attr(open, "aria-label") || attr(open, "title"), ARIA_CHARS);
    if (!target && !aria) continue;
    out.push({ href: target, label: shown.replace(LINK_SUFFIX, "").trim(), aria: aria.replace(LINK_SUFFIX, "").trim() });
  }
  return out;
}

/** "1위 야마모토 클리닉 요나고, 관광객 처방 가능, …" → "야마모토 클리닉 요나고" */
function firstClause(s: string): string {
  return stripRank(s.split(/[,，、|·•\n]/)[0] ?? "").trim();
}

const ARROW = /[\s›»→＞>▼▲▽△▶▷▸◀◁◂]/;
/** "› 야마모토 클리닉 →" → "야마모토 클리닉" (a loop: a regex for the tail would rescan every run of arrows) */
function trimArrows(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && ARROW.test(s[a]!)) a++;
  while (b > a && ARROW.test(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/**
 * "1위 …", "No.3 …", "2. …" → "…" (a rank with its marker; a bare leading number can be part of a name, and so can a
 * decimal: "2.5mg" stays); link arrows off
 */
function stripRank(s: string): string {
  // names are cut to NAME_CHARS after this: a longer line only costs time
  const t = trimArrows(s);
  const head = t.length > 500 ? t.slice(0, 500) : t;
  return trimArrows(head.replace(/^\s{0,8}(?:no\.?\s{0,3}\d{1,3}|\d{1,3}\s{0,3}(?:위|位|등|\.(?!\d)|\)))\s{0,3}(?=\S)/i, ""));
}

function nameIn(slice: string, anchors: Anchor[]): string {
  return ownName(slice, anchors) || lineName(htmlText(slice).text);
}

/** the entry's first line of text (`text`, its markup's) that says something */
function lineName(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => meaningful(l) && !GENERIC.test(l));
  return line ? stripRank(line) : "";
}

/** the entry's name from its heading, a name-class element or a link's label / aria (not from a plain text line), or "" */
function ownName(slice: string, anchors: Anchor[]): string {
  // the first heading that closes within 1500 characters (three openings looked at: a page of bare "<h1>" stays cheap)
  const hOpen = /<h[1-6]\b[^<>]{0,2000}>/gi;
  let tries = 0;
  for (let m = hOpen.exec(slice); m && tries < 3; m = hOpen.exec(slice)) {
    tries++;
    const after = m.index + m[0].length;
    const chunk = slice.slice(after, after + 1500);
    const end = chunk.search(/<\/h[1-6]\s{0,3}>/i);
    if (end < 0) continue;
    const t = stripRank(htmlText(chunk.slice(0, end)).text.replace(/\s+/g, " ").trim());
    // a section's heading that is a menu's word ("アクセス") names no place
    if (meaningful(t) && !buttonLabel(t)) return t;
    break;
  }
  const re = /<([a-z][a-z0-9-]{0,30})\b([^<>]{0,2000})>/gi;
  let seen = 0;
  for (let m = re.exec(slice); m && seen < 200; m = re.exec(slice)) {
    seen++;
    const cls = attr(m[0], "class").toLowerCase().split(/\s+/);
    if (!cls.some((c) => NAME_CLASS.test(c))) continue;
    const after = m.index + m[0].length;
    const chunk = slice.slice(after, after + 1500);
    const end = chunk.search(new RegExp(`</${m[1]}\\s*>`, "i"));
    const t = htmlText(end >= 0 ? chunk.slice(0, end) : chunk.slice(0, 300)).text.replace(/\s+/g, " ").trim();
    if (meaningful(t) && t.length <= 120) return stripRank(t);
  }
  // a link's words that only go with a button's ("公式 ▶" beside "公式サイト ▶", "もっと") are none either
  for (const a of anchors) if (meaningful(a.label) && !plainLabel(a.label) && !buttonLabel(a.label, true) && a.label.length <= 80 && !CONTACT_HREF.test(a.href)) return stripRank(a.label);
  for (const a of anchors) {
    const t = firstClause(a.aria);
    if (meaningful(t) && !linkLabel(t)) return t;
  }
  return "";
}

/**
 * A card named only by what its links do ("지도보기", "アクセス" over "地図を開く ↗"): its first line of text holding a
 * clinic's word (ビューティーオンクリニック銀座 under "06 / GINZA, TOKYO"), else "" (its first line names it, see lineName)
 */
function kindLine(text: string): string {
  for (const l of text.split("\n", 60)) {
    const t = stripRank(l.replace(/\s+/g, " ").trim());
    if (t.length <= 80 && KIND_WORD.test(t) && /^[\p{L}\p{N}]/u.test(t) && !addressOnly(t)) return t;
  }
  return "";
}

/**
 * A card's name other than its address (see addressOnly): its heading, bold text, image alt or link title — the first
 * that is a name ("" when none is)
 */
function otherName(slice: string, anchors: Anchor[]): string {
  const ok = (t: string) => meaningful(t) && t.length <= 80 && !addressOnly(t) && !linkLabel(t);
  // an image's alt that says what the image is ("카페 분위기 이미지", "店内の写真") names no place
  const picture = /이미지|사진|image|photo|picture|写真|画像|イメージ|thumbnail|썸네일|logo|로고|ロゴ|icon|아이콘/i;
  const tags = /<(h[1-6]|strong|b)\b[^<>]{0,2000}>|<img\b([^<>]{0,2000})>/gi;
  let seen = 0;
  for (let m = tags.exec(slice); m && seen < 20; m = tags.exec(slice)) {
    seen++;
    if (!m[1]) {
      const alt = cleanLabel(attr(m[0], "alt"), NAME_CHARS);
      if (ok(alt) && !picture.test(alt)) return alt;
      continue;
    }
    const after = m.index + m[0].length;
    const chunk = slice.slice(after, after + 1500);
    const end = chunk.search(new RegExp(`</${m[1]}\\s{0,3}>`, "i"));
    if (end < 0) continue;
    const t = stripRank(htmlText(chunk.slice(0, end)).text.replace(/\s+/g, " ").trim());
    if (ok(t)) return t;
  }
  for (const a of anchors) if (ok(a.aria)) return a.aria;
  return "";
}

/** "ディオクリニック 大阪梅田院│医療ダイエット専門…" → the name before its tagline */
const TITLE_TAGLINE = /\s{0,3}[｜│|]/;
/** "【吹田】…", "[梅田] …": an area tag in front */
const TITLE_TAG = /^\s{0,3}(?:【[^】]{1,20}】|［[^］]{1,20}］|\[[^\]]{1,20}\])\s{0,3}/;
/** "…の基本情報", "… クリニック情報", "… 기본 정보", "… information": the heading of a block about the place, not its name */
const TITLE_INFO =
  /\s{0,3}(?:の)?(?:基本情報|詳細情報|クリニック情報|医院情報|病院情報|店舗情報|施設情報|情報|詳細|概要)$|\s{0,3}(?:기본\s?)?정보$|\s{0,3}(?:상세|개요)$|\s{1,3}(?:info(?:rmation)?|details|overview)$/iu;
/** how far before an entry its heading is looked for */
const TITLE_LOOKBACK = 20_000;
/** a heading left with only the kind of place ("クリニック" of "クリニックの基本情報", "当院"): it names none */
const KIND_ONLY = /^(?:当?(?:クリニック|医院|病院|診療所)|当院|clinic|hospital|클리닉|병원|의원|본원)$/iu;

/**
 * the name in the last heading closing in `gap` (the page between the entry before and this one), or "". With `up`, a
 * heading that names nothing ("기본 정보" under "<h2>서초구청 주차장</h2>") is part of the section above it: the last
 * heading of a higher rank before it names the entry (only for an entry named by nothing else, see retitle: a table's
 * section heading over "クリニック概要" is no place's name)
 */
function titleBefore(gap: string, up = false): string {
  // one pass for the last closing tag of each rank, then its opening within 1500 characters before it
  const last: (RegExpExecArray | undefined)[] = [];
  let close: RegExpExecArray | null = null;
  const closes = /<\/h([2-6])\s{0,3}>/gi;
  for (let m = closes.exec(gap); m; m = closes.exec(gap)) last[Number(m[1])] = close = m;
  if (!close) return "";
  const named = (c: RegExpExecArray): string => {
    const head = gap.slice(Math.max(0, c.index - 1500), c.index);
    const opens = new RegExp(`<h${c[1]}\\b[^<>]{0,2000}>`, "gi");
    let open: RegExpExecArray | null = null;
    for (let m = opens.exec(head); m; m = opens.exec(head)) open = m;
    if (!open) return "";
    const t = htmlText(head.slice(open.index + open[0].length)).text.replace(/\s+/g, " ").trim();
    const name = stripRank(t.split(TITLE_TAGLINE)[0] ?? "").replace(TITLE_TAG, "").replace(TITLE_INFO, "").trim();
    return meaningful(name) && !linkLabel(name) && !KIND_ONLY.test(name) ? cleanLabel(name, NAME_CHARS) : "";
  };
  const own = named(close);
  if (own || !up) return own;
  const rank = Number(close[1]);
  let above: RegExpExecArray | undefined;
  for (let r = 2; r < rank; r++) if (last[r] && (!above || last[r]!.index > above.index)) above = last[r];
  return above ? named(above) : "";
}

function resolve(href: string, base: URL): URL | null {
  // "javascript:;" and its typo "javascript;" (a relative path that leads nowhere)
  if (!href || href.startsWith("#") || /^\s{0,8}javascript\b/i.test(href)) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** a line of an entry's text that says something: not a link's or a button's words alone ("詳しく見る", "地図を開く") */
function saysSomething(l: string): boolean {
  const bare = l.replace(LINK_SUFFIX, "");
  return !!bare.trim() && !GENERIC.test(bare) && !(BUTTON_ACT.test(bare) && buttonLabel(bare));
}

/** one entry's text in a line, without its name, rank, "자세히 보기"-style link words, placeholder phones and its area clause */
function entryText(full: string, name: string, area = ""): string {
  const lines = scrubPlaceholderPhones(full)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(saysSomething);
  let t = lines.join(" · ");
  if (name) {
    const i = t.indexOf(name);
    // a rank in front of it goes with it ("P · 1. 수서역 환승주차장 · …": the heading's "1." is no name's part)
    if (i >= 0 && i < 40) t = `${t.slice(0, i).replace(/(^|[\s·])\d{1,3}(?:\s?(?:위|位)|\.)?\s*$/, "$1")}${t.slice(i + name.length)}`;
  }
  // the name is gone: a number left in front is the entry's rank; arrows and "›" are link icons
  t = t
    .replace(/^[\s·]*\d{1,3}(?:\s*(?:위|位|\.))?(?=\s|·|$)/, "")
    .replace(/(^|\s)[›»→＞>▼▲▽△▶▷▸◀◁◂](?=\s|$)/g, "$1")
    .replace(/(?:\s*·\s*)+/g, " · ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s·]+|[\s·]+$/g, "");
  // the area is the item's own field: out of the text where it ends a clause ("亀戸 도쿄 가메이도 · 역 도보 2분" →
  // "亀戸 · 역 도보 2분"); an address cut to its area stays whole ("大阪市中央区心斎橋筋2-7-18")
  const at = area ? t.indexOf(area) : -1;
  const end = at + area.length;
  if (at >= 0 && (at === 0 || t[at - 1] === " ") && (end === t.length || t.startsWith(" · ", end))) {
    const head = t.slice(0, at).replace(/(?: ·)? $/, "");
    const tail = t.slice(end).replace(/^ · /, "");
    t = head && tail ? `${head} · ${tail}` : head || tail;
  }
  return cleanLabel(t, TEXT_CHARS);
}

/** class tokens of an entry's location element ("lc", "loc", "shop-addr", "area-name", "locality", "region" …) */
const AREA_CLASS =
  /^(?:lc|area(?:[-_]?(?:name|nm|txt|text|label|info))?|(?:[a-z]+[-_])?(?:loc|location|locality|addr|address|adr|region|city|pref|prefecture|district|ward)(?:[-_]?(?:name|nm|txt|text|label|info))?|[a-z]+[-_]area[-_]?(?:name|nm|txt|text|label))$/;
const NOT_AREA_CLASS = /^(?:street|e?mail|ip|web|url|site)/;
/** an element looked at for an address alone: its inner HTML up to here (a road and a number fit many times over) */
const ADDRESS_ELEMENT_CHARS = 400;
const AREA_TAGS = new Set(["span", "p", "div", "dd", "dt", "td", "li", "small", "em", "i", "b", "strong", "address", "cite", "figcaption", "h3", "h4", "h5", "h6"]);
const AREA_DATA = ["data-area", "data-city", "data-region", "data-location", "data-address", "data-pref"];

/**
 * the entry's location element (class / itemprop / <address>; short text only), else a data-area-style attribute, else
 * the first element holding an address alone ("<span class="pp-street">연무장길 37-30</span>", "<b>98-1</b><span>왕십리로</span>")
 */
function areaElement(slice: string, name: string): string {
  const re = /<([a-z][a-z0-9-]{0,30})\b([^<>]{0,2000})>/gi;
  let seen = 0;
  let street = "";
  for (let m = re.exec(slice); m && seen < 200; m = re.exec(slice)) {
    seen++;
    const tag = m[1]!.toLowerCase();
    if (!AREA_TAGS.has(tag)) continue;
    const prop = attr(m[0], "itemprop").toLowerCase();
    const cls = attr(m[0], "class").toLowerCase().split(/\s+/).map((c) => c.replace(/\d+/g, ""));
    const located = tag === "address" || /^(?:address|addresslocality|addressregion)$/.test(prop) || cls.some((c) => AREA_CLASS.test(c) && !NOT_AREA_CLASS.test(c));
    if (!located && street) continue;
    const after = m.index + m[0].length;
    const chunk = slice.slice(after, after + (located ? 1500 : ADDRESS_ELEMENT_CHARS));
    const end = chunk.search(new RegExp(`</${tag}\\s*>`, "i"));
    // an address alone has its number, and is all of a short element
    if (!located && (end < 0 || !/\d/.test(chunk.slice(0, end)))) continue;
    const t = htmlText(end >= 0 ? chunk.slice(0, end) : chunk.slice(0, 300)).text.trim();
    // a wrapper that only has a location-ish class ("list-area"-style) holds a lot more than an area
    if (t.length > 160) continue;
    if (!located) {
      // a lot number alone ("98-1") says no road: no area
      if (addressOnly(t)) street = areaValue(t);
      continue;
    }
    const v = areaValue(t);
    if (v && v !== name) return v;
  }
  const open = /^<[a-z][a-z0-9-]{0,30}\b[^<>]{0,4000}>/i.exec(slice)?.[0] ?? "";
  for (const k of AREA_DATA) {
    const v = attr(open, k);
    // a slug ("tokyo", "osaka-umeda") is the site's own id, not the way it writes the area
    if (v && !/^[a-z0-9_-]+$/.test(v)) return areaValue(v);
  }
  // a name that is an address alone is its area too
  return street;
}

/** a table row's cell `col` (<td> / <th>), as text */
function cellText(slice: string, col: number): string {
  const re = /<t[dh]\b[^<>]{0,2000}>/gi;
  let i = 0;
  for (let m = re.exec(slice); m && i <= col && i < 60; m = re.exec(slice), i++) {
    if (i !== col) continue;
    const after = m.index + m[0].length;
    const chunk = slice.slice(after, after + 3000);
    const end = chunk.search(/<\/?t[dhr]\b/i);
    return htmlText(end >= 0 ? chunk.slice(0, end) : chunk.slice(0, 300)).text;
  }
  return "";
}

/**
 * a header cell's words put before its column's amounts: no link's or button's words ("詳細", "公式") nor a word for any
 * value ("項目 | 内容": a row's label is its name, 内容 says nothing more) or the table's own title ("項目 |
 * 主な3サービスの料金早見表"), no tax note ("2.5mg料金（税込）" → "2.5mg料金"), cut past 32 characters
 */
const HEAD_CHARS = 32;
const VALUE_HEAD =
  /^(?:内容|説明|値|情報|データ|내용|설명|값|정보|데이터|contents?|values?|info(?:rmation)?|description|data)$|(?:料金表|価格表|早見表|比較表|一覧表?|요금표|가격표|비교표|price\s?list|comparison|overview)$/iu;
const TAX_ASIDE = /\s{0,2}[(（]\s{0,2}(?:税込み?|税抜き?|税別|부가세\s?(?:포함|별도)|tax\s?(?:incl\.?|included|excl\.?|excluded))\s{0,2}[)）]/giu;
/** a cell saying there is no value ("—", "-", "－"): left out of a row's text under the header's labels */
const NO_VALUE = /^[\s\-－–—―‐]*$/u;

function headLabel(cell: string): string {
  const t = cell.replace(/\s+/g, " ").replace(TAX_ASIDE, "").replace(/[\s:：]+$/, "").trim();
  return meaningful(t) && !linkLabel(t) && !VALUE_HEAD.test(t) ? cleanLabel(t, HEAD_CHARS) : "";
}

/**
 * header labels naming places side by side ("項目 | クリニックフォア 心斎橋院 | Wクリニック 梅田院", "| 梅田院（提携院） | 大阪府大阪市
 * 中央区…": half the columns after the first or more hold a clinic's or a branch's word, or an address): a comparison by
 * column, its rows keep their values bare
 */
const BRANCH_WORD = /(?<=\p{L})(?<![医病寺])(?:院|店)(?=$|[\s（()）・/、,，])/u;
function placeHeads(heads: string[]): boolean {
  const rest = heads.slice(1).filter(Boolean);
  return rest.filter((h) => KIND_WORD.test(h) || BRANCH_WORD.test(h) || !!areaIn(h)).length * 2 >= rest.length;
}

/**
 * a table's labels from its header row's cells, or [] when they are none: no label, places side by side (see
 * placeHeads), or a row of values (an amount in a cell: Exa's copy writes a table's first row of values as its header,
 * "| アンカーX | 1本 | 23,100円 |")
 */
function headsOf(cells: string[]): string[] {
  if (cells.some((c) => CELL_AMOUNT.test(c))) return [];
  const heads = cells.map(headLabel);
  return heads.some(Boolean) && !placeHeads(heads) ? heads : [];
}

/**
 * A table row's cells as text, one per cell in order (`<td>` / `<th>`), or null when one spans columns or rows or the
 * row holds a table: then its cells line up with no header
 */
function rowCells(row: string): string[] | null {
  if (/<table\b/i.test(row)) return null;
  const opens: { at: number; end: number }[] = [];
  const re = /<t[dh]\b([^<>]{0,2000})>/gi;
  for (let c = re.exec(row); c; c = re.exec(row)) {
    if (/\b(?:col|row)span\s{0,3}=\s{0,3}["']?\s{0,3}0{0,3}(?:[2-9]|[1-9]\d)/i.test(c[1]!) || opens.length >= 60) return null;
    opens.push({ at: c.index, end: c.index + c[0].length });
  }
  return opens.map((o, k) => {
    const cell = row.slice(o.end, k + 1 < opens.length ? opens[k + 1]!.at : row.length);
    const stop = cell.search(/<\/t[dhr]\s{0,3}>/i);
    return htmlText(stop >= 0 ? cell.slice(0, stop) : cell).text;
  });
}

/**
 * A table's header labels, one per column: its last row of `<th>` cells (or of its `<thead>`) before its first row of
 * `<td>` cells, among its first 4 rows (a row of one cell, the table's title or a section's, is none); [] when it has
 * none or a header cell spans columns
 */
function tableHeads(table: string): string[] {
  let heads: string[] = [];
  const row = /<tr\b[^<>]{0,2000}>/gi;
  let head = false;
  let body = false;
  let from = 0;
  for (let m = row.exec(table), n = 0; m && n < 4; m = row.exec(table), n++) {
    // where the row sits: inside the <thead>, before a <tbody>
    const before = table.slice(from, m.index);
    if (/<thead\b/i.test(before)) head = true;
    if (/<tbody\b|<\/thead\s{0,3}>/i.test(before)) body = true;
    from = m.index;
    const after = m.index + m[0].length;
    const chunk = table.slice(after, after + 8_000);
    const end = chunk.search(/<\/tr\s{0,3}>|<tr\b/i);
    const cells = end >= 0 ? chunk.slice(0, end) : chunk;
    if (/<td\b/i.test(cells) && !(head && !body)) break;
    if ((cells.match(/<t[dh]\b/gi) ?? []).length === 1) continue;
    const labels = rowCells(cells);
    if (!labels) return [];
    heads = headsOf(labels);
  }
  return heads;
}

/** a dose ("2.5mg", "3 mg", "0.5ml"): a label's dose over a value naming another ("リベルサス3mg 10,470円" under 2.5mg) is not its */
const DOSE = /(\d+(?:\.\d+)?)\s{0,2}(mg|ml|cc|μg|mcg)(?![a-z])/giu;
const doses = (t: string) => new Set([...t.normalize("NFKC").toLowerCase().matchAll(DOSE)].map((d) => `${Number(d[1])}${d[2]}`));
/** an amount of money in a cell ("4,800円", "1万円", "3만원", "¥29,800", "$12") */
const CELL_AMOUNT = /\d(?:[\d,.]{0,12})\s{0,2}(?:円|万円|원|만\s{0,2}원|천\s{0,2}원|ドル|元|dollars?)|[¥￥$€£₩]\s{0,2}\d/iu;

/** a label's words for "says it already" (NFKC, lower case, no spaces) and its doses: once per table's labels */
type HeadKeys = { flat: string[]; doses: Set<string>[] };
const HEAD_KEYS = new WeakMap<string[], HeadKeys>();
const flatKey = (x: string) => x.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
function headKeys(heads: string[]): HeadKeys {
  let k = HEAD_KEYS.get(heads);
  if (!k) HEAD_KEYS.set(heads, (k = { flat: heads.map(flatKey), doses: heads.map(doses) }));
  return k;
}

/** a row's lines by cell under its header (see headPieces): `first`, the cell's first line with its label, when it takes one */
type HeadPiece = { lines: string[]; first?: string };

/**
 * Each row's text under its table's header labels ("院 | 2.5mg 1本 | 初診料 | Google" over "イースト駅前 | 4,800円 | — |
 * ★4.6": "2.5mg 1本 4,800円 · ★4.6"): the cell that names the entry (`nameAt`) and those before it (a rank, a logo) as
 * they are; after it each amount with its column's label before it (what the price is for: a dose, 1本, 初診料), unless
 * the cell says it already ("初診料 2,000円" under 初診料) or names another dose than the label's. Other values stay as
 * they are (a label there only takes room in the entry's 110 characters: an area, 自費, ★4.6), a cell saying there is
 * none ("—") and a link's or a button's words ("詳しく見る" under 詳細) leave
 */
function headPieces(cells: string[], heads: string[], nameAt: number): HeadPiece[] {
  const keys = headKeys(heads);
  const out: HeadPiece[] = [];
  cells.forEach((cell, k) => {
    const lines = cell.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (k <= nameAt) {
      if (lines.length) out.push({ lines });
      return;
    }
    const said = lines.filter(saysSomething);
    if (!said.length || NO_VALUE.test(said.join(""))) return;
    const label = heads[k] ?? "";
    // the label goes with the cell's first line (its other lines stay parts of their own), when the cell holds an amount
    // and names no other dose up to it (the words the label goes with)
    const upto = label ? said.findIndex((l) => CELL_AMOUNT.test(l)) : -1;
    if (upto < 0 || flatKey(said[0]!).startsWith(keys.flat[k]!)) {
      out.push({ lines: said });
      return;
    }
    const own = doses(said.slice(0, upto + 1).join(" "));
    const other = [...keys.doses[k]!].some((d) => own.size && !own.has(d));
    out.push(other ? { lines: said } : { lines: said, first: `${label} ${said[0]}` });
  });
  return out;
}

/** the pieces' lines with the first `labels` labels, the first `maxLines` lines */
function underPieces(pieces: HeadPiece[], labels = Infinity, maxLines = Infinity): string {
  const out: string[] = [];
  let given = 0;
  for (const p of pieces) {
    if (out.length >= maxLines) break;
    if (p.first !== undefined && given++ < labels) out.push(p.first, ...p.lines.slice(1));
    else out.push(...p.lines);
  }
  return out.slice(0, maxLines).join("\n");
}

/** amounts of money an entry's text shows whole (a part cut short at its end, "…", shows none) */
const SHOWN_AMOUNT = /[¥￥$€£₩]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:万円|円|만\s?원|천\s?원|원|ドル|元|dollars?)/giu;
function shownAmounts(t: string): string[] {
  const whole = t.endsWith("…") ? t.slice(0, Math.max(0, t.lastIndexOf(" · "))) : t;
  return [...whole.matchAll(SHOWN_AMOUNT)].map((m) => m[0].replace(/\s/g, ""));
}

/**
 * A row's text under its table's header labels (see headPieces), as many of them as keep every amount its text without
 * labels shows within the 110 characters ("Cap - 100,000 $7.00 · 100,001 - 500,000 $5.60 · $4.20 · $2.10 · $0.53", not
 * a text cut before $2.10): the last amounts' labels go first, the first amount's stays (the price a reader takes)
 */
function labelledText(pieces: HeadPiece[], name: string, area?: string): string {
  // what shows is in the first lines: those filling twice the text's room, the name and the area besides, decide
  const bare = underPieces(pieces, 0).split("\n");
  let lines = 0;
  for (let room = 2 * TEXT_CHARS + name.length + (area?.length ?? 0); lines < bare.length && room > 0; lines++) room -= bare[lines]!.length + 3;
  const text = (labels: number) => entryText(underPieces(pieces, labels, lines), name, area);
  const cut = (t: string) => t.length >= TEXT_CHARS && t.endsWith("…");
  // the first lines' text is the row's when it is cut short (no later line shows) or they are all its lines
  const whole = (labels: number, t = text(labels)) => (cut(t) || lines >= bare.length ? t : entryText(underPieces(pieces, labels), name, area));
  const all = whole(Infinity);
  if (!cut(all)) return all;
  const need = shownAmounts(text(0));
  const keeps = (t: string) => {
    const have = shownAmounts(t);
    return need.every((a) => {
      const i = have.indexOf(a);
      return i >= 0 && !!have.splice(i, 1);
    });
  };
  if (keeps(all)) return all;
  // fewer labels never show fewer amounts: the most that keep them all, 1 at least (labels past the lines that decide
  // change nothing)
  let best = 1;
  let shown = 0;
  for (let k = 0, n = 0; k < pieces.length && n < lines; n += pieces[k++]!.lines.length) if (pieces[k]!.first !== undefined) shown++;
  for (let lo = 2, hi = shown - 1; lo <= hi; ) {
    const mid = (lo + hi) >> 1;
    if (keeps(text(mid))) [best, lo] = [mid, mid + 1];
    else hi = mid - 1;
  }
  return whole(best);
}

/** the cell holding the entry's name as shown (a name cut short, ending in "…", by its start), or -1 */
function nameCell(cells: string[], shown: string): number {
  const flat = (x: string) => x.normalize("NFKC").replace(/\s+/g, "");
  const name = flat(shown.replace(/…$/, ""));
  return name ? cells.findIndex((c) => flat(c).includes(name)) : -1;
}

/** the area column of the table a list of rows sits in (its header row: <th> cells, or the <thead>'s), or -1 */
function tableAreaColumn(html: string, first: Member): number {
  const lo = Math.max(0, first.start - 20_000);
  const head = html.slice(lo, Math.min(first.end, first.start + 8_000));
  let table = -1;
  const t = /<table\b/gi;
  for (let m = t.exec(head); m; m = t.exec(head)) table = m.index;
  if (table < 0) return -1;
  const row = /<tr\b[^<>]{0,2000}>/gi;
  row.lastIndex = table;
  let rows = 0;
  for (let m = row.exec(head); m && rows < 3; m = row.exec(head)) {
    rows++;
    const after = m.index + m[0].length;
    const chunk = head.slice(after, after + 8_000);
    const end = chunk.search(/<\/tr\s*>|<tr\b/i);
    const cells = end >= 0 ? chunk.slice(0, end) : chunk;
    const inHead = /<thead\b/i.test(head.slice(table, m.index)) && !/<tbody\b/i.test(head.slice(table, m.index));
    if (!/<th\b/i.test(cells) && !inHead) continue;
    const re = /<t[dh]\b[^<>]{0,2000}>/gi;
    let i = 0;
    for (let c = re.exec(cells); c && i < 60; c = re.exec(cells), i++) {
      const rest = cells.slice(c.index + c[0].length);
      const stop = rest.search(/<\/?t[dh]\b/i);
      if (isAreaHeader(htmlText(stop >= 0 ? rest.slice(0, stop) : rest.slice(0, 200)).text)) return i;
    }
    return -1;
  }
  return -1;
}

/** "あべしゅん内科 福岡市" in a row whose area column says "福岡市": the area is the item's own field */
function withoutArea(name: string, area: string): string {
  if (!area || area.length > 20 || area.length >= name.length) return name;
  const t = name.replace(/[\s)）]+$/, "");
  if (!t.endsWith(area)) return name;
  const rest = t.slice(0, t.length - area.length);
  if (!/[\s(（]$/.test(rest)) return name;
  const cut = rest.replace(/[\s(（]+$/, "");
  return (cut.match(/\p{L}/gu)?.length ?? 0) >= 2 ? cut : name;
}

/** a tag's word that only advertises the page ("【公式】", "【PR】", "【2026年最新】", "(광고)"): dropped from the name */
const AD_TAG =
  /^(?:公式(?:サイト|HP)?|PR|AD|広告|スポンサー|sponsored|プロモーション|(?:\d{4}年(?:\d{1,2}月)?)?(?:最新(?:版|情報)?|版|更新)|おすすめ|オススメ|人気|話題|注目|新着|NEW|ランキング|광고|공식(?:\s?(?:사이트|홈페이지))?|협찬|추천|인기|최신|(?:\d{4}년\s?(?:\d{1,2}월\s?)?)?(?:최신|업데이트))$/iu;
/** "…など", "… 周辺", "… 일대": the end of a list of places */
const TAG_MORE = /\s{0,2}(?:など|ほか|他|周辺|近辺|エリア|方面|各院|等|일대|근처|주변|등|지역)$/u;
/** a word that is a way of seeing a doctor, never a place */
const NOT_PLACE = /オンライン|ウェブ|電話|LINE|online|web|온라인|전화|비대면|화상/iu;
/** the line that holds a place's whereabouts ("アクセス | 天下茶屋駅徒歩1分", "住所：…", "위치 · …") */
const WHERE_LABEL = /^(?:アクセス|交通|最寄り?駅|住所|所在地|場所|エリア|地域|立地|위치|지역|주소|소재지|동네|교통|오시는\s?길|access|address|location|area)$/iu;
const WHERE_CUE = /^(?:アクセス|交通|最寄り?駅|住所|所在地|場所|エリア|地域|立地|위치|지역|주소|소재지|동네|교통|오시는\s?길|access|address|location|area)\s{0,2}[:：]/iu;
/** a ward, city or town by its own word: "西区", "吹田市", "本町" (not "地区", "各市", "都市") */
const MUNICIPALITY = /^(?!(?:地|全|各|特|市|都|区|町)[区市町村郡]$)[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々ヶ]{1,6}[区市町村郡]$/u;
/** a JP prefecture by its own word, with its 都・道・府・県 or without: "群馬", "群馬県", "大阪府", "東京", "北海道" */
const PREFECTURE =
  /^(?:北海道|東京都?|(?:大阪|京都)府?|(?:青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県?)$/u;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** a bracketed tag at the end of a name ("…【心斎橋】", "… [梅田]", "…（難波）", "… (신사이바시)") or at its front */
function nameTag(name: string): { rest: string; tag: string; whole: string } | null {
  const t = name.trim();
  const pairs: [string, string][] = [["【", "】"], ["［", "］"], ["[", "]"], ["（", "）"], ["(", ")"], ["（", ")"], ["(", "）"]];
  for (const [open, close] of pairs) {
    if (t.endsWith(close)) {
      const at = t.lastIndexOf(open, t.length - 2);
      if (at < 1) continue;
      const tag = t.slice(at + open.length, t.length - close.length).trim();
      if (tag && tag.length <= 30 && !/[【】［］[\]（）()]/.test(tag)) return { rest: t.slice(0, at).trim(), tag, whole: t.slice(at) };
    }
    if (t.startsWith(open)) {
      const at = t.indexOf(close, 1);
      if (at < 0 || at === t.length - 1) continue;
      const tag = t.slice(open.length, at).trim();
      if (tag && tag.length <= 30 && !/[【】［］[\]（）()]/.test(tag)) return { rest: t.slice(at + close.length).trim(), tag, whole: t.slice(0, at + close.length) };
    }
  }
  return null;
}

/**
 * Whether a name's tag names the place's whereabouts ("【心斎橋・梅田・天王寺など】", "【西区・西大橋】"): each of its
 * parts is a prefecture, ward, city, town or station by its own word (群馬, 大阪府, 西区, 吹田市, 天満駅前, 신주쿠역)
 * or is found in the entry itself as a place (the tag left out: "（Vラインエリア）" is no place for its own エリア): in
 * its area, before 駅 / 区 / 市 / エリア / 역 …, or in its access or address line ("アクセス | 天下茶屋駅徒歩1分"). A
 * word without such a sign ("【オンライン診療】", "（二の腕）", "(Goto Clinic)") is not one.
 */
function placeTag(tag: string, text: string, area: string | undefined): boolean {
  const parts = tag.replace(TAG_MORE, "").split(/\s{0,2}[・･、,，/／&＆]\s{0,2}|\s{1,3}/u).map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 6) return false;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const where = lines.filter((l, i) => WHERE_CUE.test(l) || (i > 0 && WHERE_LABEL.test(lines[i - 1]!.replace(/[:：]$/, ""))));
  return parts.every((part) => {
    const core = part.replace(/(?:駅前?|역)$/u, "");
    if ((core.match(/\p{L}/gu)?.length ?? 0) < 2 || /\d/.test(core) || NOT_PLACE.test(core) || AD_TAG.test(core)) return false;
    if (MUNICIPALITY.test(core) || PREFECTURE.test(core) || core !== part || area?.includes(core)) return true;
    return new RegExp(`${escapeRe(core)}(?:駅|区|市|町|エリア|周辺|역)`, "u").test(text) || where.some((l) => l.includes(core));
  });
}

/**
 * The name without its tag: one that names the place's whereabouts (see placeTag) becomes its area when it has none (an
 * area read from its address stays); one that only advertises the page (AD_TAG) is dropped; any other stays, it tells
 * entries apart ("（初回）" / "（2回目以降）", "【オンライン診療】", "(남성 전용)").
 */
function untagged(name: string, text: string, area: string | undefined): { name: string; area?: string } {
  let out = name;
  let place: string | undefined;
  // tags at both ends, a few of them ("【公式】【PR】○○クリニック【2026年最新】【梅田】")
  for (let i = 0; i < 4; i++) {
    const t = nameTag(out);
    if (!t || (t.rest.match(/\p{L}/gu)?.length ?? 0) < 2 || plainLabel(t.rest) || GENERIC.test(t.rest)) break;
    if (AD_TAG.test(t.tag)) {
      out = t.rest;
      continue;
    }
    if (place || !placeTag(t.tag, text.split(t.whole).join("\n"), area)) break;
    place = t.tag;
    out = t.rest;
  }
  return place && !area ? { name: out, area: cleanLabel(place, AREA_CHARS) } : { name: out };
}

function htmlItem(html: string, m: Member, base: URL, pageUrl: URL, areaCol = -1, heads: string[] = []): ListItem | null {
  const slice = COLUMN_HTML.get(m) ?? html.slice(m.start, Math.min(m.end, m.start + SLICE_MAX));
  if (/<th\b/i.test(slice) && !/<td\b/i.test(slice)) return null; // a table's header row
  const anchors = anchorsIn(slice);
  // the name as shown (the text loses it whole); `name` may then lose the area at its end. A row "クリニック名 | ○○"
  // of the entry's table (or of its rows, see records) names it before its heading or link does
  const row = RECORDS.get(m) ?? tableName(slice);
  const own = row?.name || ownName(slice, anchors);
  const buttons = !own && anchors.some((a) => a.href && buttonLabel(a.label));
  const said = htmlText(slice).text;
  const line = own ? "" : (buttons ? kindLine(said) : "") || lineName(said);
  let shown = cleanLabel(own || line, NAME_CHARS);
  // a name that is only an address ("연무장길 37-30"): another name in the card names it, the address is its area
  const address = addressOnly(shown) ? shown : "";
  if (address) shown = cleanLabel(otherName(slice, anchors), NAME_CHARS) || shown;
  let name = shown;
  if (!meaningful(name)) return null;
  // a table row under its header's labels: each value after the name with its column's label (see headPieces)
  const cells = !row && heads.length ? rowCells(slice) : null;
  const at = cells && cells.length === heads.length ? nameCell(cells, shown) : -1;
  const pieces = at >= 0 ? headPieces(cells!, heads, at) : null;
  const full = row ? withoutLine(said, row.label) : pieces ? underPieces(pieces) : said;
  const contacts = new Collector(2);
  const urls: { u: URL; label: string }[] = [];
  for (const a of anchors) {
    if (schemeContact(a.href, contacts, a.label)) continue;
    const u = resolve(a.href, base);
    if (!u || samePage(u, pageUrl)) continue;
    const hit = fromHref(u, a.label);
    if (hit) {
      contacts.add(hit.kind, hit.c);
      continue;
    }
    urls.push({ u, label: meaningful(a.label) && !GENERIC.test(a.label) ? a.label : a.aria ? firstClause(a.aria) : a.label });
  }
  textContacts(full, contacts);
  const item = { name } as ListItem;
  const tel = telKey(contacts.out.phones[0]?.value);
  if (tel) item.tel = tel;
  const column = areaCol >= 0 ? areaValue(cellText(slice, areaCol)) : "";
  const area = column || areaElement(slice, name) || areaIn(full) || (address ? areaValue(address) : "");
  if (area && (area !== name || address)) {
    item.area = area;
    // a table row whose name cell repeats its area column; elsewhere an area in the name is part of it ("클리니크 후쿠오카 텐진")
    if (column) name = item.name = withoutArea(name, area);
  }
  const main = urls.find((x) => x.label && (x.label.includes(name) || name.includes(x.label))) ?? urls[0];
  if (main) {
    item.url = displayUrl(main.u);
    if (!sameSite(main.u.hostname, pageUrl.hostname)) item.domain = displayHost(main.u.hostname);
  }
  // a tag on the name: its place to the area, an ad's word off (after the main link is picked: by the name as shown)
  const plain = untagged(item.name, full, item.area);
  item.name = plain.name;
  if (plain.area) item.area = plain.area;
  const text = pieces ? labelledText(pieces, shown, item.area) : entryText(full, shown, item.area);
  if (text) item.text = text;
  const seen = new Set<string>(main ? [main.u.origin + main.u.pathname] : []);
  const links: ItemLink[] = [];
  for (const x of urls) {
    const k = x.u.origin + x.u.pathname;
    if (seen.has(k) || links.length >= ITEM_LINKS) continue;
    seen.add(k);
    links.push({ label: cleanLabel(meaningful(x.label) ? x.label : displayHost(x.u.hostname), 40), url: displayUrl(x.u) });
  }
  if (links.length) item.links = links;
  const cs = contactStrings(contacts.out, ITEM_CONTACTS);
  if (cs.length) item.contacts = cs;
  // its link says only "公式サイト" or its address, and nothing in it names the place: see retitle
  if (!own && item.url && anchors.some((a) => a.href && linkLabel(a.label))) UNTITLED.add(item);
  // named by the first cell of a table's header row ("施術タイプ | 料金 | 特徴", "院名 | 住所 | 電話番号"): see columnTables
  if (line && line === columnLabel(slice)) COLUMN_NAMED.add(item);
  if (OWN_COLUMN.has(m)) COLUMN_PLACES.add(item);
  return item;
}

/** entries of this read named only by a line of their text while their link says "公式サイト" or its address */
const UNTITLED = new WeakSet<ListItem>();
/** entries of this read named by a column's label */
const COLUMN_NAMED = new WeakSet<ListItem>();

/** the first cell of the first row of the entry's table, when that row has two cells or more (a header row), or "" */
function columnLabel(slice: string): string {
  const table = /<table\b/i.exec(slice);
  if (!table) return "";
  const row = /<tr\b[^<>]{0,2000}>/gi;
  row.lastIndex = table.index;
  const tr = row.exec(slice);
  if (!tr) return "";
  const after = tr.index + tr[0].length;
  const rest = slice.slice(after, after + 8_000);
  const end = rest.search(/<\/tr\s{0,3}>|<tr\b/i);
  const cells = (end >= 0 ? rest.slice(0, end) : rest).split(/<t[dh]\b[^<>]{0,2000}>/i).slice(1);
  if (cells.length < 2) return "";
  const first = htmlText(cells[0]!.replace(/<\/t[dh]\s{0,3}>[\s\S]*$/i, "")).text.replace(/\s+/g, " ").trim();
  return stripRank(first);
}

/** a row label that names the place ("クリニック名 | ○○クリニック", "병원명 | …"): its other cell is the name */
const NAME_LABEL =
  /^(?:クリニック名|医院名|病院名|院名|店舗名|店名|施設名|医療機関名|正式名称|名称|병원\s?(?:명|이름)|의원명|클리닉\s?(?:명|이름)|상호(?:명)?|업체명|기관명|시설명|매장명|점포명|(?:clinic|hospital|store|shop|business|facility)\s?name|name)$/i;
/**
 * a row label about a place, whole or one of its parts ("住所", "電話番号", "診察日・受付時間", "公式サイトURL", "주소",
 * "진료시간"): the table is about one ("アクセスクリニック" in a clinic's row is a name, not this)
 */
const PLACE_WORD =
  /^(?:住所|所在地|場所|アクセス|最寄り?駅|電話(?:番号)?|TEL|診療(?:時間|日|科目?)|診察(?:日|時間)|(?:営業|受付)(?:時間|日)|休診日?|定休日|公式(?:サイト|HP|ホームページ)(?:URL)?|URL|ホームページ|(?:WEB|ウェブ)?予約(?:方法)?|院長|주소|위치|소재지|전화(?:\s?번호)?|연락처|진료\s?(?:시간|과목|일)|영업\s?시간|휴무일?|휴진일?|홈페이지|예약(?:\s?방법)?|오시는\s?길|address|location|phone|tel|(?:opening\s)?hours|website|access)$/i;
const placeLabel = (label: string) => label.split(/\s{0,2}[・／/&＆、,]\s{0,2}/).some((p) => PLACE_WORD.test(p));
/** rows of one table looked at for its name rows (as many as a list's rows) */
const LABEL_ROWS = MAX_MEMBERS;
/** a label cell longer than this is text, not a label */
const LABEL_CHARS = 30;

interface LabelRow {
  /** where the row's <tr> starts in the table's slice */
  at: number;
  /** the value cell's text ("" for a logo: the entry's link or heading names it) */
  name: string;
  /** the line its entry's text leaves out: the row's label ("クリニック名"), a branch row's name ("梅田院"); "" for a heading's */
  label: string;
}

/** a cell's text when it is short enough to be a label (its colon off), else "" */
function labelText(cell: string): string {
  if (cell.length > 600) return "";
  const t = htmlText(cell).text.replace(/\s+/g, " ").trim().replace(/\s{0,3}[：:]$/, "");
  return t.length <= LABEL_CHARS ? t : "";
}

/**
 * The name rows of a table that describes places row by row ("項目 | 内容", then "クリニック名 | ○○", "住所 | …"; or
 * "クリニック名 | ○○" as its first row): a row of two cells whose label names the place (NAME_LABEL), in a table with a
 * label row about a place too (PLACE_WORD). A comparison with a clinic per row ("クリニック名 | 院内での注射のサポート",
 * then "あおば内科 | あり") has none, nor has a drug's table ("正式名称 | …", "一般名 | …"); one of two clinics side by
 * side ("クリニック名 | A | B") has three cells.
 */
function nameRows(table: string): LabelRow[] {
  const s = labelRows(table);
  return s.place ? s.rows : [];
}

/** a table's name rows, and whether a row of two cells is labelled about a place */
function labelRows(table: string): { rows: LabelRow[]; place: boolean } {
  const rows: LabelRow[] = [];
  let place = false;
  const tr = /<tr\b[^<>]{0,2000}>/gi;
  let looked = 0;
  for (let m = tr.exec(table); m && looked < LABEL_ROWS; m = tr.exec(table)) {
    looked++;
    const after = m.index + m[0].length;
    const rest = table.slice(after, after + 8_000);
    const end = rest.search(/<\/tr\s{0,3}>|<tr\b/i);
    const row = end >= 0 ? rest.slice(0, end) : rest;
    const cell = /<t[dh]\b[^<>]{0,2000}>/gi;
    const opens: RegExpExecArray[] = [];
    for (let c = cell.exec(row); c && opens.length < 3; c = cell.exec(row)) opens.push(c);
    if (opens.length !== 2) continue;
    const [a, b] = opens as [RegExpExecArray, RegExpExecArray];
    const label = labelText(row.slice(a.index + a[0].length, b.index).replace(/<\/t[dh]\s{0,3}>[\s\S]*$/i, ""));
    if (!label) continue;
    if (placeLabel(label)) place = true;
    if (!NAME_LABEL.test(label)) continue;
    const value = htmlText(row.slice(b.index + b[0].length).replace(/<\/t[dh]\s{0,3}>[\s\S]*$/i, "")).text.replace(/\s+/g, " ").trim();
    rows.push({ at: m.index, name: cleanLabel(value, NAME_CHARS), label });
  }
  return { rows, place };
}

/**
 * A table about one place whose rows only label its parts ("項目 | 特徴", then "地図", "料金プラン", "住所", "アクセス",
 * "公式サイト | 公式サイトはこちら"), without a name row: the place is the one in the last heading of `gap` (the page
 * since the table before it). Its name row, or null
 */
function placeTable(gap: string): LabelRow | null {
  const name = titleBefore(gap);
  return name ? { at: 0, name, label: "" } : null;
}

/**
 * the place an entry's own table names: its first name row with a name (a logo's empty one else), or null. A card
 * whose tables name two places is two entries by then (see branchCards)
 */
function tableName(slice: string): LabelRow | null {
  let found: LabelRow | null = null;
  const open = /<table\b[^<>]{0,2000}>/gi;
  let tables = 0;
  for (let m = open.exec(slice); m && tables < CARD_TABLES; m = open.exec(slice)) {
    tables++;
    const close = slice.slice(m.index).search(/<\/table\s{0,3}>/i);
    for (const r of nameRows(close >= 0 ? slice.slice(m.index, m.index + close) : slice.slice(m.index))) if (!found?.name) found = r;
  }
  return found;
}

/** the text without the first line that is `label` ("クリニック名" of the row that named the entry) */
function withoutLine(text: string, label: string): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.replace(/\s+/g, " ").trim().replace(/\s{0,3}[：:]$/, "") === label);
  if (i >= 0) lines.splice(i, 1);
  return lines.join("\n");
}

/**
 * An article's block per place (a table of 住所 / 診療時間 / 公式サイト under "<h4>…の基本情報</h4>") names the place
 * only in the heading before it: such an entry takes the name in the last heading between the entry before it (one
 * with a link) and itself — when most such entries of the list have one, so a list of named cards keeps its names
 */
function retitle(html: string, main: { m: Member; item: ListItem }[]): void {
  const found: { item: ListItem; title: string }[] = [];
  let untitled = 0;
  let prevEnd = 0;
  for (const { m, item } of main) {
    if (UNTITLED.has(item)) {
      untitled++;
      const title = titleBefore(html.slice(Math.max(prevEnd, m.start - TITLE_LOOKBACK), m.start), true);
      if (title) found.push({ item, title });
    }
    if (item.url) prevEnd = Math.max(prevEnd, m.end);
  }
  if (untitled < 2 || found.length * 5 < untitled * 3) return;
  for (const { item, title } of found) {
    // the line that named it ("영업시간" of "영업시간 · 평일 00:00~24:00") goes back to its words
    if (item.name !== title && !nothing(item.name)) item.text = cleanLabel([item.name, item.text].filter(Boolean).join(" · "), TEXT_CHARS);
    item.name = title;
  }
}

/**
 * A table named by a column's label ("施術タイプ", "比較軸", "マンジャロの規格") compares treatments or prices: no entry. One
 * with a phone or another contact lists a place's branches ("院名 | 住所 | 電話番号"): the place in the section's heading
 * (the last one before it, also when the place's linked table comes first); it keeps its label when there is none
 */
function columnTables(html: string, main: { m: Member; item: ListItem }[]): { m: Member; item: ListItem }[] {
  const out: { m: Member; item: ListItem }[] = [];
  for (const x of main) {
    const { m, item } = x;
    if (COLUMN_NAMED.has(item) && !item.url) {
      if (!item.tel && !item.contacts?.length) continue;
      const title = titleBefore(html.slice(Math.max(0, m.start - TITLE_LOOKBACK), m.start));
      if (title) item.name = title;
    }
    out.push(x);
  }
  return out;
}

// ───────────────────────────── the same place ─────────────────────────────

/** words for the kind of place, not its name (specialties such as 내과, 피부과, 内科, 皮膚科 are kept: they tell places apart) */
const KIND_SUFFIX = /(?:클리닉스?|의원|병원|의료원|메디컬|메디칼|진료소|クリニック|医院|病院|診療所|メディカル|clinics?|hospital|medical)$/u;
const KIND_PREFIX = /^(?:의료법인|医療法人(?:社団|財団)?|社団|財団)/u;
const NAME_SEPARATORS = /[\s·・/|,()（）［］[\]「」『』"'‘’“”‐\-–—_.&＆+~〜:：]+/u;

/**
 * a reading in kana after a name in Latin letters only ("eLife（イーライフ）", "Actually,（アクチュアリー）"): the same name
 * written again, not a part of it. A word for how or whom a place sees (オンライン, メンズ …) is no reading, nor a tag
 * after a name with other words ("GLP-1内服（リベルサスなど）")
 */
const READING_TAG = /^(.+?)\s?[(\[【]\s?([ぁ-ゖァ-ヺー・ヽヾゝゞ ]{2,30}?)\s?[)\]】]$/u;
const NOT_READING = /^(?:オンライン|オフライン|メンズ|レディー?ス|ウィメンズ|キッズ|ジュニア|シニア)$/u;

/** see ListItem.key */
export function placeKey(name: string): string {
  let flat = name.normalize("NFKC").toLowerCase().slice(0, 200).trim();
  const reading = READING_TAG.exec(flat);
  if (reading && /[a-z]/.test(reading[1]!) && /^[a-z\d\s\p{P}\p{S}]+$/u.test(reading[1]!) && !NOT_READING.test(reading[2]!.replace(/\s/g, ""))) flat = reading[1]!;
  const tokens: string[] = [];
  for (const raw of flat.split(NAME_SEPARATORS)) {
    let t = raw.replace(KIND_PREFIX, "");
    for (let i = 0; i < 2 && t; i++) t = t.replace(KIND_SUFFIX, "");
    if (t) tokens.push(t);
  }
  const letters = (x: string) => x.match(/\p{L}/gu)?.length ?? 0;
  // a name that is only a kind word and a number ("병원 0") keeps its kind word
  let core = tokens.join("");
  if (letters(core) < 2) core = flat.split(NAME_SEPARATORS).join("");
  return core;
}

/** see ListItem.tel */
export function telKey(phone: string | undefined): string | undefined {
  if (!phone || placeholderPhone(phone)) return undefined;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return undefined;
  if (!phone.trim().startsWith("+")) return digits;
  for (const cc of ["81", "82"]) {
    if (!digits.startsWith(cc)) continue;
    const rest = digits.slice(cc.length);
    return rest.startsWith("0") ? rest : `0${rest}`;
  }
  return `+${digits}`;
}

/**
 * A building or branch word ending a part of the name: "新館", "アネックス", "2号館", "名古屋院", "渋谷店", "신관",
 * "강남점", "3호점". Two names that differ by one are two places even when one name holds the other.
 */
const BRANCH_MARK =
  /(?:新館|別館|本館|分館|\d+号館|アネックス|annex|本院|分院|別院|本店|支店|\d*号店|신관|별관|본관|본원|분원|본점|분점|지점|\d+호점|(?<![医病寺])院|(?<=\p{L})店|(?<=[가-힣]{2})점)$/u;

/** the last branch word in a name ("" when it has none) */
function branchMark(name: string): string {
  const parts = name.normalize("NFKC").toLowerCase().slice(0, 200).split(NAME_SEPARATORS);
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = BRANCH_MARK.exec(parts[i]!);
    if (m) return m[0];
  }
  return "";
}

/**
 * One entry per place: the same URL with the same (or a contained) name in the same area once — two clinics or two
 * branches linking one site stay apart ("あさひ美容外科" in 堺市 and in 大阪市, "銀座プラタナクリニック" and
 * "ＺＥＮクリニック", "エースクリニック" and "エースクリニック アネックス" in one building, "…クリニック" and
 * "…クリニック新館"); a block without a link named like an entry with a link or phone before it (same key) that
 * brings the area or phone the entry lacks and no other one (a clinic's table of 住所 / 電話番号 under its heading,
 * after its card) once, while a comparison's row that brings neither stays. The entry kept takes the area, tel,
 * contacts and links it lacks from a copy dropped either way. The same tel with the same (or a contained) name and the
 * same branch word once, its other URL kept among its links. A comparison's column (see columnBranches) without a link
 * or phone named like an entry with one (same key, a compatible area), before it or after it, is that entry: it goes,
 * its area to that entry when it lacks one. A page that lists one clinic twice (same name, URL and area) shows it once.
 * Names alone never merge here otherwise — a directory lists each branch on its own ("마루 클리닉" in two cities); `key`
 * lets a reader of several pages tell which entries may be the same place.
 */
/** a text's segments as explore's listPrice cuts them (" · ", " ・ ", " | ") */
const TEXT_SEGMENT = /\s[·・|｜･]\s/gu;
/** amounts as explore's listPrice reads them (its PRICE_RUN): "16,440円", "¥4,500", "3만 원" */
const AMOUNTS = /[¥￥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:万円|만\s?원|円|엔|원)/gu;

/** where a text's first segment with an amount (not 0) ends; 0 without one */
function amountEnd(t: string): number {
  let start = 0;
  TEXT_SEGMENT.lastIndex = 0;
  for (;;) {
    const m = TEXT_SEGMENT.exec(t);
    const end = m ? m.index : t.length;
    const seg = t.slice(start, end).normalize("NFKC");
    if (seg.match(AMOUNTS)?.some((a) => /[1-9]/.test(a))) return end;
    if (!m) return 0;
    start = m.index + m[0].length;
  }
}

/** a text's first segments within `max` characters, "…" after the last one kept; cut inside the first one if it is longer */
function segmentsWithin(t: string, max: number): string {
  let end = 0;
  TEXT_SEGMENT.lastIndex = 0;
  for (let m = TEXT_SEGMENT.exec(t); m && m.index + 1 <= max; m = TEXT_SEGMENT.exec(t)) end = m.index;
  return end ? `${t.slice(0, end).replace(/…$/, "")}…` : cleanLabel(t, max);
}

/**
 * The texts of an entry and a copy of it merged into it, its own first, within TEXT_CHARS: each keeps half of it at
 * least, the entry's text through its first amount (the price a reader takes from it stays the same) — a comparison's
 * column (prices) and the clinic's card (hours, access) both say something
 */
export function joinTexts(own: string | undefined, other: string | undefined): string | undefined {
  if (!own || !other) return own || other;
  const bare = (t: string) => t.replace(/…$/, "");
  if (other.startsWith(bare(own))) return other;
  // the copy's words the entry's text lacks ("住所 · 大阪市中央区難波2-2-2" said once; a segment one of them cut short,
  // "4本セット：27,450円（2回目以降32,450…", is the same segment). A short one stays beside a new one: the label or value
  // of it ("再診料 · 無料" when the text has "配送料 · 無料")
  const mine = own.split(TEXT_SEGMENT).map(bare);
  const known = (x: string) => mine.some((m) => m === x || (Math.min(m.length, x.length) >= 6 && (x.startsWith(m) || m.startsWith(x))));
  const parts = other.split(TEXT_SEGMENT).map((x) => [x, bare(x)] as const).filter(([, b]) => b);
  const said = parts.map(([, b]) => known(b));
  const lone = (i: number) => i < 0 || i >= parts.length || said[i]!;
  other = parts.filter(([, b], i) => !said[i] || (b.length < 6 && (!lone(i - 1) || !lone(i + 1)))).map(([x]) => x).join(" · ");
  if (!other || own.includes(bare(other))) return own;
  const sep = " · ";
  if (own.length + sep.length + other.length <= TEXT_CHARS) return `${own}${sep}${other}`;
  const keep = Math.max((TEXT_CHARS - sep.length) >> 1, amountEnd(own) + 1, TEXT_CHARS - sep.length - other.length);
  let head = own.length <= keep ? own : segmentsWithin(own, keep);
  // whole segments, unless that leaves much of its share unused: then cut inside one
  if (own.length > keep && keep - head.length > 12) head = `${own.slice(0, keep - 1).replace(/[\s·・|｜･]+$/u, "")}…`;
  const room = TEXT_CHARS - sep.length - head.length;
  // none when too little room is left for the copy's words to say anything; the copy cut after a whole part says so
  // with its mark alone ("… · ア · …" is "… · ア…")
  return room < 12 ? own : `${head}${sep}${cleanLabel(other, room).replace(/[\s·・|｜･]+…$/u, "…")}`;
}

/** a name ending in an arrow out ("카페 탐방 ↗", "오늘의 팝업 ↗"): a link to more of the site, no place. "→" / "›" after a
 * clinic's name are its card's link icon (see trimArrows) */
const OUT_ARROW = /[↗⇗➚➶➹⬈⤴⤤↪🡕🡥]\uFE0F?$/u;

function dedupe(all: ListItem[]): { items: ListItem[]; cut?: true } {
  const items = all.filter((x) => !OUT_ARROW.test(x.name));
  const seen = new Map<string, { it: ListItem; mark: string }[]>();
  const byTel = new Map<string, { it: ListItem; mark: string }>();
  const byKey = new Map<string, { it: ListItem; mark: string }[]>();
  const out: ListItem[] = [];
  const filled = new Set<ListItem>();
  const near = (a: string, b: string) => a === b || a.includes(b) || b.includes(a);
  const sameArea = (a: ListItem, b: ListItem) => !a.area || !b.area || near(a.area, b.area);
  // `join`: the copy's text too, when a link, phone or key with one says it is the same place (rows of a name alone, such
  // as one label "診察料" in several clinics' tables, keep the first one's words)
  const fill = (kept: ListItem, copy: ListItem, join: boolean) => {
    filled.add(kept);
    kept.area ??= copy.area;
    kept.tel ??= copy.tel;
    const text = join ? joinTexts(kept.text, copy.text) : kept.text;
    if (text) kept.text = text;
    const contacts = [...new Set([...(kept.contacts ?? []), ...(copy.contacts ?? [])])].slice(0, ITEM_CONTACTS);
    if (contacts.length) kept.contacts = contacts;
    const links = [...new Map([...(kept.links ?? []), ...(copy.links ?? [])].map((l) => [l.url, l])).values()].slice(0, ITEM_LINKS);
    if (links.length) kept.links = links;
  };
  // entries by key: those with a link or phone, and the other ones that are no column
  const reached = new Map<string, ListItem[]>();
  const unlinked = new Map<string, ListItem[]>();
  for (const x of items) {
    if (!x.url && !x.tel && COLUMN_PLACES.has(x)) continue;
    const k = placeKey(x.name);
    const by = x.url || x.tel ? reached : unlinked;
    const list = by.get(k);
    if (list) list.push(x);
    else by.set(k, [x]);
  }
  const gone = new Set<ListItem>();
  for (const x of items) {
    if (!COLUMN_PLACES.has(x) || x.url || x.tel) continue;
    const k = placeKey(x.name);
    // the entry of its key with a link or phone, else one without (its card: the column elife, the card eLife（イーライフ）)
    const linked = reached.get(k)?.find((o) => sameArea(o, x)) ?? unlinked.get(k)?.find((o) => sameArea(o, x));
    if (!linked) continue;
    linked.area ??= x.area;
    const text = joinTexts(linked.text, x.text);
    if (text) linked.text = text;
    gone.add(x);
  }
  for (const raw of items) {
    if (gone.has(raw)) continue;
    // key, tel and area right after the name, the rest in its order
    const { name, tel, area, key: _built, ...rest } = raw;
    const it: ListItem = { name, key: placeKey(name), ...(tel ? { tel } : {}), ...(area ? { area } : {}), ...rest };
    const mark = branchMark(name);
    const k = (raw.url ?? `name:${raw.name}`).toLowerCase();
    const same = seen.get(k);
    const copy = same?.find((o) => o.mark === mark && near(o.it.key, it.key) && sameArea(o.it, it));
    if (copy) {
      fill(copy.it, it, !!raw.url);
      continue;
    }
    // a block without a link that names an entry with one before it and brings its area or phone (no other area or phone)
    const named = !raw.url && it.key
      ? byKey.get(it.key)?.find((o) => (o.it.url || o.it.tel) && sameArea(o.it, it) && (!o.it.tel || !tel || o.it.tel === tel) && ((!o.it.area && area) || (!o.it.tel && tel)))
      : undefined;
    if (named) {
      fill(named.it, it, true);
      continue;
    }
    if (same) same.push({ it, mark });
    else seen.set(k, [{ it, mark }]);
    const twin = tel ? byTel.get(tel) : undefined;
    // a later block with that phone naming the entry in its words, no place by its own name ("運営・取引のご案内" with
    // "運営：ビューティーオンクリニック銀座"): a part of it
    const part = !!twin && !KIND_WORD.test(it.name) && (twin.it.name.match(/\p{L}/gu)?.length ?? 0) >= 4 && (it.text ?? "").includes(twin.it.name);
    if (twin && ((twin.mark === mark && near(twin.it.key, it.key)) || part)) {
      const t = twin.it;
      if (it.url && it.url !== t.url && (t.links?.length ?? 0) < ITEM_LINKS) t.links = [...(t.links ?? []), { label: cleanLabel(it.name, 40), url: it.url }];
      const text = joinTexts(t.text, it.text);
      if (text) t.text = text;
      continue;
    }
    if (tel) byTel.set(tel, { it, mark });
    if (it.key) {
      const list = byKey.get(it.key);
      if (list) list.push({ it, mark });
      else byKey.set(it.key, [{ it, mark }]);
    }
    if (out.length >= MAX_ITEMS) return { items: out.map((x) => (filled.has(x) ? ordered(x) : x)), cut: true };
    out.push(it);
  }
  return { items: out.map((x) => (filled.has(x) ? ordered(x) : x)) };
}

/** an entry with key, tel and area right after its name */
function ordered(x: ListItem): ListItem {
  const { name, key, tel, area, ...rest } = x;
  return { name, key, ...(tel ? { tel } : {}), ...(area ? { area } : {}), ...rest };
}

/** entries made from tables, one per place (see records, branchCards): the row (or heading) that names each */
const RECORDS = new WeakMap<Member, LabelRow>();
/** entries that are a column of a table of places side by side: that column's rows as a table (see columnBranches) */
const COLUMN_HTML = new WeakMap<Member, string>();
/** such columns naming places of their own (a comparison's), and the entries made of them (see dedupe) */
const OWN_COLUMN = new WeakSet<Member>();
const COLUMN_PLACES = new WeakSet<ListItem>();
/** tables looked at on a page for records */
const RECORD_TABLES = 5_000;

/**
 * A list of table rows where tables describe places row by row ("クリニック名 | ○○", "住所 | …", "電話番号 | …",
 * "公式サイト | https://…" — see nameRows): each place is one entry, from its name row to the next one (or its
 * table's end), with its link, phone and area together. A table of one place's label rows without a name row (see
 * placeTable) is one entry too, named by its heading, and a table of a place's branches side by side one entry per
 * branch or place (see columnBranches). Rows before a table's first name row, and every row of other tables (a price
 * table), stay entries of their own; a table comparing made-up places has none (see exampleTable). Only when the rows
 * hold two places or more: one place's table is that place's page, its rows stay as they are.
 */
function records(html: string, rows: Member[]): Member[] {
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  const { owner, ends } = rowTables(html, sorted);
  const byTable = new Map<number, Member[]>();
  for (const r of sorted) {
    const s = owner.get(r);
    if (s === undefined) continue;
    const list = byTable.get(s);
    if (list) list.push(r);
    else byTable.set(s, [r]);
  }
  // each folded row, and the entries it is part of (one, or a table's branch columns)
  const folded = new Map<Member, Member[]>();
  const made: Member[] = [];
  let prevEnd = 0;
  for (const [s, members] of byTable) {
    if (made.length >= MAX_ITEMS) break;
    const end = ends.get(s) ?? Math.min(html.length, members[members.length - 1]!.end);
    const scan = labelRows(html.slice(s, end));
    let named = scan.place ? scan.rows : [];
    const gap = html.slice(Math.max(prevEnd, s - TITLE_LOOKBACK), s);
    if (scan.place && !named.length) {
      const one = placeTable(gap);
      if (one) named = [one];
    }
    prevEnd = Math.max(prevEnd, end);
    const table = html.slice(s, end);
    const example = !named.length && exampleTable(table);
    const columns = named.length || example ? [] : columnParts(table, titleBefore(gap), { start: s, end, depth: members[0]!.depth, chrome: members[0]!.chrome, parentAt: members[0]!.parentAt });
    if (columns.length) {
      made.push(...columns);
      for (const r of members) folded.set(r, columns);
    } else if (example) for (const r of members) folded.set(r, []);
    for (let k = 0; k < named.length; k++) {
      const from = s + named[k]!.at;
      const to = k + 1 < named.length ? s + named[k + 1]!.at : end;
      const inside = members.filter((r) => r.start >= from && r.start < to);
      if (!inside.length) continue;
      const first = inside[0]!;
      const rec: Member = { start: from, end: Math.min(to, Math.max(...inside.map((r) => r.end))), depth: first.depth, chrome: first.chrome, parentAt: first.parentAt };
      RECORDS.set(rec, named[k]!);
      made.push(rec);
      for (const r of inside) folded.set(r, [rec]);
    }
  }
  if (made.length < 2) return rows.filter((r) => folded.get(r)?.length !== 0);
  const out: Member[] = [];
  const placed = new Set<Member>();
  for (const r of sorted) {
    const recs = folded.get(r);
    if (!recs) out.push(r);
    for (const rec of recs ?? []) {
      if (placed.has(rec)) continue;
      placed.add(rec);
      out.push(rec);
    }
  }
  return out;
}

/** each row's innermost table (where its <table> tag starts), and where each table ends: one pass over the page's <table> tags */
function rowTables(html: string, sorted: Member[]): { owner: Map<Member, number>; ends: Map<number, number> } {
  const owner = new Map<Member, number>();
  const ends = new Map<number, number>();
  const stack: number[] = [];
  const tag = /<(\/?)table\b[^<>]{0,2000}>/gi;
  let i = 0;
  let tags = 0;
  for (let t = tag.exec(html); ; t = tag.exec(html)) {
    const at = t ? t.index : html.length;
    for (; i < sorted.length && sorted[i]!.start < at; i++) if (stack.length) owner.set(sorted[i]!, stack[stack.length - 1]!);
    if (!t || ++tags > RECORD_TABLES * 2) break;
    if (!t[1]) stack.push(t.index);
    else {
      const s = stack.pop();
      if (s !== undefined) ends.set(s, t.index);
    }
  }
  return { owner, ends };
}

/** each row's table header labels (see tableHeads), a row of a table without them none */
function rowHeads(html: string, rows: Member[]): Map<Member, string[]> {
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  const { owner, ends } = rowTables(html, sorted);
  const byTable = new Map<number, string[]>();
  const out = new Map<Member, string[]>();
  for (const r of sorted) {
    const s = owner.get(r);
    if (s === undefined) continue;
    let heads = byTable.get(s);
    // the row's own table (not one around it) from its start: its header is in its first rows, before the first data
    // row, whichever row of the list comes first (a title row can be one)
    if (!heads) byTable.set(s, (heads = tableHeads(html.slice(s, Math.min(ends.get(s) ?? html.length, s + 40_000)))));
    if (heads.length) out.set(r, heads);
  }
  return out;
}

/** tables looked at in one card for its branches */
const CARD_TABLES = 5;
/** a group's branch word left after its name ("大阪各院", the "大阪院" of "品川美容外科 大阪院（梅田院・心斎橋院）") */
const GROUP_BRANCH = /\s{1,3}\S{1,12}(?:院|店舗?)$/u;
/** a word of a clinic's own name: a row holding one names a place ("ディオクリニック 大阪梅田院"), not one of its branches ("梅田院") */
const KIND_WORD = /クリニック|医院|病院|診療所|美容外科|皮膚科|内科|外科|歯科|メディカル|clinic|hospital|medical|의원|병원|클리닉|치과/i;
const KIND_WORDS = new RegExp(KIND_WORD.source, "gi");

interface BranchRow {
  /** where the row's <tr> starts in the table's slice, and where its cells end */
  at: number;
  end: number;
  name: string;
}

/**
 * The branch rows of a table with a header row ("院名 | 住所 | アクセス | 電話番号", then "梅田院 | 大阪市北区… | … | 06-…"):
 * its first cell names the place (NAME_LABEL) and another is about one (PLACE_WORD); each later row of two cells or
 * more whose first cell is short names a branch. [] for other tables, and for one whose rows name places of their own
 * (a comparison: "クリニック名 | エリア | 診療時間", then "ディオクリニック 大阪梅田院 | 梅田 | …")
 */
function headerBranches(table: string): BranchRow[] {
  const out: BranchRow[] = [];
  const tr = /<tr\b[^<>]{0,2000}>/gi;
  let looked = 0;
  for (let m = tr.exec(table); m && looked < LABEL_ROWS; m = tr.exec(table)) {
    looked++;
    const after = m.index + m[0].length;
    const rest = table.slice(after, after + 8_000);
    const close = rest.search(/<\/tr\s{0,3}>|<tr\b/i);
    const row = close >= 0 ? rest.slice(0, close) : rest;
    const cells = row.split(/<t[dh]\b[^<>]{0,2000}>/i).slice(1, 13).map((c) => c.replace(/<\/t[dh]\s{0,3}>[\s\S]*$/i, ""));
    if (looked === 1) {
      const labels = cells.map(labelText);
      if (cells.length < 2 || !NAME_LABEL.test(labels[0]!) || !labels.slice(1).some((l) => l && placeLabel(l))) return [];
      continue;
    }
    if (cells.length < 2) continue;
    const name = labelText(cells[0]!);
    if (meaningful(name)) out.push({ at: m.index, end: after + row.length, name });
  }
  return out.filter((r) => KIND_WORD.test(r.name)).length * 2 > out.length ? [] : out;
}

/** the place a heading names before its branches ("エミナルクリニック" of "エミナルクリニック 梅田院・心斎橋院・天王寺院") */
function groupName(title: string, branches: string[]): string {
  let cut = title.length;
  for (const b of branches) {
    const i = title.indexOf(b);
    if (i >= 0 && i < cut) cut = i;
  }
  // a branch written with its city ("Wクリニック（大阪梅田院・心斎橋院）" for 梅田院) goes whole: up to 3 letters after a
  // separator, never the place's own name ("さくらクリニック梅田院")
  const city = /[\s·・/|,、(（［[「『:：〜~\-–—]([^\s·・/|,、(（［[「『:：〜~\-–—]{1,3})$/u.exec(title.slice(0, cut));
  if (city && cut < title.length) cut -= city[1]!.length;
  const group = title.slice(0, cut).replace(/[\s·・/|,、(（［[「『:：〜~\-–—]+$/u, "");
  return group.replace(GROUP_BRANCH, "");
}

/** a branch's entry name: the place's and the branch's ("エミナルクリニック 心斎橋院"), the branch's alone when it has the place's */
function branchName(group: string, branch: string): string {
  return branch.includes(group) ? branch : cleanLabel(`${group} ${branch}`, NAME_CHARS);
}

/** a row label about where a place is (its address, its way there, its phone): a table with one is about places */
const WHERE_WORD = /^(?:住所|所在地|アクセス|最寄り?駅|電話(?:番号)?|TEL|주소|위치|소재지|전화(?:\s?번호)?|오시는\s?길|address|location|phone|tel|access)$/i;

/**
 * A table of places side by side, one per column after its first cell: a place's branches ("項目 | 梅田院 | 心斎橋院",
 * then "住所 | 大阪市北区… | 大阪市中央区…", "電話番号 | 06-… | 06-…", "公式サイト | <a> | <a>") with a later row of as
 * many cells about where they are (WHERE_WORD), or places of their own compared ("クリニック名 | クリニックフォア |
 * DMMクリニック | デジタルクリニック", then "受診方法 | オンライン診療 | …"): most header cells hold a word of a
 * clinic's name (KIND_WORD), none is such words alone ("診療科 | 内科 | 外科" heads a clinic's departments), and half
 * its row labels at most hold one ("提携 | ○○クリニック | …" then "さくら内科 | ○ | ×" names places by row). Each
 * column as a table of its header cell (its link) and its own rows ("住所 | 大阪市北区…"), `own` for places of their
 * own; [] for other tables: branches without a row about where compare plans ("項目 | 対面 | オンライン")
 */
function columnBranches(table: string): { name: string; rows: string; own: boolean }[] {
  const tr = /<tr\b[^<>]{0,2000}>/gi;
  let names: string[] = [];
  let cols: string[] = [];
  let where = false;
  let own = false;
  let labels = 0;
  let kinds = 0;
  let looked = 0;
  for (let m = tr.exec(table); m && looked < LABEL_ROWS; m = tr.exec(table)) {
    looked++;
    const after = m.index + m[0].length;
    const rest = table.slice(after, after + 8_000);
    const close = rest.search(/<\/tr\s{0,3}>|<tr\b/i);
    const cells = (close >= 0 ? rest.slice(0, close) : rest).split(/<t[dh]\b[^<>]{0,2000}>/i).slice(1, 13).map((c) => c.replace(/<\/t[dh]\s{0,3}>[\s\S]*$/i, ""));
    if (looked === 1) {
      names = cells.slice(1).map(labelText);
      if (names.length < 2 || !names.every(meaningful)) return [];
      own = names.filter((n) => KIND_WORD.test(n)).length * 2 > names.length;
      if (own && names.some((n) => !/\p{L}/u.test(n.replace(KIND_WORDS, "")))) return [];
      cols = cells.slice(1).map((c) => `<tr><td></td><td>${c}</td></tr>`);
      continue;
    }
    const label = cells.length === names.length + 1 ? labelText(cells[0]!) : "";
    if (!label) continue;
    labels++;
    if (KIND_WORD.test(label)) kinds++;
    if (label.split(/\s{0,2}[・／/&＆、,]\s{0,2}/).some((p) => WHERE_WORD.test(p))) where = true;
    for (let k = 0; k < names.length; k++) if (cols[k]!.length < SLICE_MAX) cols[k] += `<tr><td>${cells[0]}</td><td>${cells[k + 1]}</td></tr>`;
  }
  const ok = own ? kinds * 2 <= labels : where;
  return ok ? names.map((name, k) => ({ name, rows: `<table>${cols[k]}</table>`, own })) : [];
}

/** the mark standing for a made-up name's letter, at its start or end ("クリニックA", "A院", "○○クリニック") */
const PLACEHOLDER = /^([A-Z]|[○◯△□×]{1,2})(?=\S)|(?<=\S)([A-Z]|[○◯△□×]{1,2})$/u;

/**
 * A table comparing made-up places side by side ("項目 | クリニックA | クリニックB", "| A院 | B院 | C院"): its header
 * names two or more after its first cell, each a mark (PLACEHOLDER; letters in order from A: "Wクリニック | Mクリニック"
 * are names) on one stem that holds a clinic's word (or is 院 / 店 alone)
 */
function exampleTable(table: string): boolean {
  const tr = /<tr\b[^<>]{0,2000}>/i.exec(table);
  if (!tr) return false;
  const after = tr.index + tr[0].length;
  const rest = table.slice(after, after + 8_000);
  const close = rest.search(/<\/tr\s{0,3}>|<tr\b/i);
  const cells = (close >= 0 ? rest.slice(0, close) : rest).split(/<t[dh]\b[^<>]{0,2000}>/i).slice(2, 13);
  if (cells.length < 2) return false;
  const stems = new Set<string>();
  for (let k = 0; k < cells.length; k++) {
    const name = labelText(cells[k]!.replace(/<\/t[dh]\s{0,3}>[\s\S]*$/i, "")).normalize("NFKC");
    const m = PLACEHOLDER.exec(name);
    const mark = m?.[1] ?? m?.[2];
    if (!mark || (/^[A-Z]$/.test(mark) && mark.charCodeAt(0) !== 65 + k)) return false;
    stems.add(name.replace(PLACEHOLDER, "").trim());
  }
  const stem = [...stems][0]!;
  return stems.size === 1 && (KIND_WORD.test(stem) || /^(?:院|店)$/u.test(stem));
}

/**
 * a table of places side by side (see columnBranches) as one entry per column: a branch named by the place in `title`,
 * a place of its own by its column; [] else
 */
function columnParts(table: string, title: string, at: Member): Member[] {
  const columns = columnBranches(table);
  const group = columns.length ? groupName(title, columns.map((c) => c.name)) : "";
  return columns.map((c) => {
    const part: Member = { ...at };
    RECORDS.set(part, { at: 0, name: c.own ? c.name : branchName(group, c.name), label: c.name });
    COLUMN_HTML.set(part, c.rows);
    if (c.own) OWN_COLUMN.add(part);
    return part;
  });
}

/**
 * A card that is a table of a place's branches by row (see headerBranches) under a heading naming the place
 * ("エミナルクリニック 梅田院・心斎橋院・天王寺院", "TCB東京中央美容外科 大阪各院"): one entry per row, named by the place and
 * the row ("エミナルクリニック 心斎橋院"; the heading is the last one before the table, also when the place's linked table
 * comes first; with none, the row alone), with the row's own phone and area; so is a table of its branches side by
 * side, one entry per column (see columnBranches). The card's part before the table (or after it) stays an entry when
 * it has a link. null for other cards
 */
function branchTable(html: string, m: Member, slice: string): Member[] | null {
  const open = /<table\b[^<>]{0,2000}>/gi;
  let tables = 0;
  for (let t = open.exec(slice); t && tables < CARD_TABLES; t = open.exec(slice)) {
    tables++;
    const close = slice.slice(t.index).search(/<\/table\s{0,3}>/i);
    const table = close >= 0 ? slice.slice(t.index, t.index + close) : slice.slice(t.index);
    const rows = headerBranches(table);
    const at = m.start + t.index;
    const title = titleBefore(html.slice(Math.max(0, at - TITLE_LOOKBACK), at));
    const card = { depth: m.depth, chrome: m.chrome, parentAt: m.parentAt };
    const byRow = new Set(rows.map((r) => r.name)).size >= 2;
    const columns = byRow || exampleTable(table) ? [] : columnParts(table, title, { start: at, end: at + table.length, ...card });
    if (!byRow && !columns.length) continue;
    const group = groupName(title, rows.map((r) => r.name));
    const head = HAS_LINK.test(slice.slice(0, t.index));
    const out: Member[] = head ? [{ start: m.start, end: at, ...card }] : [];
    if (columns.length) out.push(...columns);
    else
      for (const r of rows) {
        const part: Member = { start: at + r.at, end: at + r.end, ...card };
        RECORDS.set(part, { at: r.at, name: branchName(group, r.name), label: r.name });
        out.push(part);
      }
    const tail = at + table.length;
    if (!head && HAS_LINK.test(slice.slice(tail - m.start))) out.push({ start: tail, end: m.end, ...card });
    return out;
  }
  return null;
}

/**
 * A card holding a table per branch, each named by its own name row ("クリニック名 | エミナクリニック 梅田院", then a
 * table "クリニック名 | エミナクリニック 心斎橋院"): one entry per branch, from its name row to the next one (the card's
 * start goes with the first), each with its own link, phone and area. Name rows naming one place alike stay one entry.
 */
function branchCards(html: string, cards: Member[]): Member[] {
  let split = false;
  const out: Member[] = [];
  for (const m of cards) {
    const slice = html.slice(m.start, Math.min(m.end, m.start + SLICE_MAX));
    const rows: LabelRow[] = [];
    const open = /<table\b[^<>]{0,2000}>/gi;
    let tables = 0;
    for (let t = open.exec(slice); t && tables < CARD_TABLES; t = open.exec(slice)) {
      tables++;
      const close = slice.slice(t.index).search(/<\/table\s{0,3}>/i);
      const table = close >= 0 ? slice.slice(t.index, t.index + close) : slice.slice(t.index);
      for (const r of nameRows(table)) if (r.name && r.name !== rows[rows.length - 1]?.name) rows.push({ ...r, at: m.start + t.index + r.at });
    }
    if (rows.length < 2) {
      const parts = branchTable(html, m, slice);
      if (parts) split = true;
      out.push(...(parts ?? [m]));
      continue;
    }
    split = true;
    for (let k = 0; k < rows.length; k++) {
      const part: Member = { start: k === 0 ? m.start : rows[k]!.at, end: k + 1 < rows.length ? rows[k + 1]!.at : m.end, depth: m.depth, chrome: m.chrome, parentAt: m.parentAt };
      RECORDS.set(part, rows[k]!);
      out.push(part);
    }
  }
  return split ? out : cards;
}

/** The page's main list (≥ 6 entries), or null. `base` resolves relative links (the page URL or its <base href>). */
export function htmlItems(html: string, base: URL, pageUrl: URL): ItemList | null {
  const groups = shapeGroups(html);
  const every = [...groups.values()];
  const ranked = every.filter((g) => g.members.length >= MIN_ITEMS).sort((a, b) => b.members.length - a.members.length).slice(0, 40);
  let best: Candidate | null = null;
  const cands: Candidate[] = [];
  for (const g of ranked) {
    const c = scoreGroup(html, g.tag, g.members);
    if (c) cands.push(c);
  }
  // the page says how many it lists ("一覧19院"): a group of exactly that many entries is the list, even a short one
  // (5 clinics, under MIN_ITEMS) or one scoring below cards of only part of them; never a menu. Groups of that size
  // beyond the 40 biggest are looked at too: the largest entries first, at most STATED_GROUPS / STATED_BYTES
  const stated = statedCount(html);
  if (stated) {
    const looked = new Set(ranked);
    const more = every.filter((g) => g.members.length === stated && !looked.has(g)).map((g) => ({ g, size: g.members.reduce((n, m) => n + Math.min(m.end - m.start, SLICE_MAX), 0) }));
    more.sort((a, b) => b.size - a.size);
    let bytes = 0;
    for (const { g, size } of more.slice(0, STATED_GROUPS)) {
      if (bytes + size > STATED_BYTES) continue;
      bytes += size;
      const c = scoreGroup(html, g.tag, g.members, Math.min(stated, MIN_ITEMS));
      if (c && c.members.length === stated) cands.push(c);
    }
  }
  for (const c of cands) if (!best || c.score > best.score) best = c;
  // of the stated size: entries drawn alike inside first, then the higher score; it wins with a share of the best
  // group's score, or lying inside one of its members (they are the page's sections, one of them holding the list)
  let exact: Candidate | null = null;
  let alike = false;
  if (stated) {
    for (const c of cands) {
      if (c.members.length !== stated || c.chrome) continue;
      const a = drawnAlike(html, c.members);
      if (!exact || (a && !alike) || (a === alike && c.score > exact.score)) [exact, alike] = [c, a];
    }
  }
  const within = (c: Candidate) => !!best && best.members.some((m) => m.start <= c.members[0]!.start && c.members[c.members.length - 1]!.end <= m.end);
  if (exact && best && (exact.score >= best.score * STATED_SHARE || within(exact))) best = exact;
  else if (best && best.members.length < MIN_ITEMS) best = null;
  if (!best) return null;
  const byCount = best === exact;
  // an entry's own wrapper or inner block scores about the same: take the outermost of near-equal groups
  for (const c of cands) {
    // of the stated count: only the entries' own wrappers, one around each
    if (byCount && (c.members.length !== stated || !c.members.every((m, k) => m.start <= best!.members[k]!.start && best!.members[k]!.end <= m.end))) continue;
    if (c !== best && c.score >= best.score * 0.85 && c.depth < best.depth && Math.abs(c.members.length - best.members.length) <= Math.max(1, best.members.length * 0.1)) best = c;
  }
  const chosen = best;
  const areaCol = chosen.tag === "tr" ? tableAreaColumn(html, chosen.members[0]!) : -1;
  const members = chosen.tag === "tr" ? records(html, chosen.members) : branchCards(html, chosen.members);
  const heads = chosen.tag === "tr" ? rowHeads(html, chosen.members) : new Map<Member, string[]>();
  const main = members.map((m) => ({ m, item: htmlItem(html, m, base, pageUrl, RECORDS.has(m) ? -1 : areaCol, heads.get(m)) })).filter((x): x is { m: Member; item: ListItem } => x.item !== null);
  // places folded from their rows are a list however few (the rows were enough to be one)
  const places = members === chosen.members ? 0 : main.filter((x) => RECORDS.has(x.m)).length;
  if (main.length < (byCount ? Math.min(stated, MIN_ITEMS) : MIN_ITEMS) && places < 2) return null;
  retitle(html, main);
  // a block of buttons alone ("公式サイト ▶ | 公式 ▶ | 公式 ▶" under a comparison) that no heading named: no place
  const buttoned = (x: { item: ListItem }) => UNTITLED.has(x.item) && buttonLabel(x.item.name);
  const entries = columnTables(html, main).filter((x) => !buttoned(x));
  if (!entries.length) return null;
  const extra = sameKindEntries(html, groups, chosen, entries, base, pageUrl).filter((x) => !buttoned(x));
  const all = [...entries, ...extra].sort((x, y) => x.m.start - y.m.start);
  const { items, cut } = dedupe(all.map((x) => x.item));
  // the list's own markup, with its sibling cards drawn another way before or after it (see sameKindEntries)
  const span: [number, number] = [Math.min(chosen.members[0]!.start, all[0]!.m.start), Math.max(chosen.members[chosen.members.length - 1]!.end, ...all.map((x) => x.m.end))];
  return { items, source: "html", span, ...(cut ? { cut } : {}), ...(chosen.chrome ? { menu: true as const } : {}) };
}

const BRANCH_COUNT = /[\s·(（]{0,3}\d{1,4}\s{0,3}(?:곳|개(?:\s?지점)?|지점|院|店舗?|branch(?:es)?|locations?)[)）]?$/i;

/**
 * A branch folded under a chain's <details> is named by its branch only ("우메다원"): the chain's name comes from the
 * <summary> ("다이비카이 클리닉 우메다원"), unless the branch's own name has it already; so does its area, if it has none.
 */
function withGroupName(html: string, folds: Member[], m: Member, item: ListItem): ListItem {
  let fold: Member | null = null;
  for (const d of folds) if (d.start < m.start && m.end <= d.end && (!fold || d.start > fold.start)) fold = d;
  if (!fold) return item;
  const head = html.slice(fold.start, Math.min(m.start, fold.start + 8_000));
  const open = /<summary\b[^<>]{0,2000}>/i.exec(head);
  if (!open) return item;
  const rest = head.slice(open.index + open[0].length);
  const end = rest.search(/<\/summary\s{0,3}>/i);
  if (end < 0) return item;
  const summary = rest.slice(0, end);
  // a branch without its own area has the chain's ("오사카 · 같은 병원 2개 지점" → "오사카")
  const area = item.area ? "" : areaElement(summary, "");
  const out = area ? { ...item, area } : item;
  // "체인 클리닉 2곳", "○○クリニック 3院": the count is not part of the name
  const chain = cleanLabel(nameIn(summary, anchorsIn(summary)), NAME_CHARS).replace(BRANCH_COUNT, "").trim();
  if (!meaningful(chain) || placeKey(item.name).includes(placeKey(chain))) return out;
  return { ...out, name: cleanLabel(`${chain} ${item.name}`, NAME_CHARS) };
}

/** "/clinic/…" → "aitoolog.com/clinic" */
function entryPrefix(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean);
    return seg.length > 1 ? `${u.hostname}/${seg[0]}` : null;
  } catch {
    return null;
  }
}

/**
 * Entries of the same kind drawn differently inside the list (a chain's branches folded under <details>, a sponsored
 * card): other blocks between the list's first and last entry, outside its entries, whose link has the entries' path
 * prefix (/clinic/…). The innermost such block counts (a <details> holding three branches gives the three). Cards in
 * the entries' own parent right before or after them count too, drawn with the entries' tag, nothing but blank space
 * between (a grid of five featured cards, then seven others); an article's paragraph further down with a link to the
 * site's other post does not.
 */
function sameKindEntries(html: string, groups: Map<string, Group>, best: Candidate, main: { m: Member; item: ListItem }[], base: URL, pageUrl: URL): { m: Member; item: ListItem }[] {
  const prefixes = new Set(main.map((x) => entryPrefix(x.item.url)).filter((p): p is string => p !== null));
  if (prefixes.size === 0 || prefixes.size > 3) return [];
  const lo = best.members[0]!.start;
  const hi = best.members[best.members.length - 1]!.end;
  const parent = best.members[0]!.parentAt;
  const mine = new Set(best.members);
  // the entries' siblings next to them: a chain outward from the first and the last entry, blank space between links
  const beside = new Set<Member>();
  if (best.members.every((m) => m.parentAt === parent)) {
    const sib: Member[] = [];
    for (const g of groups.values()) if (g.tag === best.tag) for (const m of g.members) if (m.parentAt === parent && (m.end <= lo || m.start >= hi) && sib.length < 2_000) sib.push(m);
    sib.sort((x, y) => x.start - y.start);
    const blank = (a: number, b: number) => b >= a && b - a <= 400 && /^\s*(?:<!--[\s\S]*?-->\s*)*$/.test(html.slice(a, b));
    let edge = lo;
    for (let k = sib.length - 1; k >= 0; k--) {
      const m = sib[k]!;
      if (m.end > edge) continue;
      if (!blank(m.end, edge)) break;
      beside.add(m);
      edge = m.start;
    }
    edge = hi;
    for (const m of sib) {
      if (m.start < edge) continue;
      if (!blank(edge, m.start)) break;
      beside.add(m);
      edge = m.end;
    }
  }
  // entries in page order: a block inside one, or around one, is part of the list's own markup
  const starts = best.members.map((m) => m.start);
  const covering = (m: Member) => {
    let a = 0;
    let b = starts.length - 1;
    while (a < b) {
      const mid = (a + b + 1) >> 1;
      if (starts[mid]! <= m.start) a = mid;
      else b = mid - 1;
    }
    const e = best.members[a]!;
    if (e.start <= m.start && m.end <= e.end) return true; // inside an entry
    const next = best.members[a + (e.start <= m.start ? 1 : 0)];
    return !!next && m.start <= next.start && next.end <= m.end; // wraps an entry
  };
  const found: { m: Member; item: ListItem }[] = [];
  // bounded work: blocks about an entry's size with a link, smallest first (the innermost block is the entry), at
  // most EXTRA_LOOKS of them and EXTRA_BYTES in all; a block around or inside a found one is not read again
  const biggest = Math.max(...best.members.map((m) => m.end - m.start));
  const cands: Member[] = [];
  for (const g of groups.values()) {
    if (cands.length >= EXTRA_CANDIDATES) break;
    for (const m of g.members) {
      if (cands.length >= EXTRA_CANDIDATES) break;
      if (mine.has(m) || ((m.start < lo || m.end > hi) && !beside.has(m)) || m.end - m.start > biggest * 4 || covering(m)) continue;
      cands.push(m);
    }
  }
  cands.sort((x, y) => x.end - x.start - (y.end - y.start) || x.start - y.start);
  // <details> blocks: a chain's branches folded under its name
  const folds: Member[] = [];
  for (const g of groups.values()) if (g.tag === "details") for (const m of g.members) if (folds.length < 2_000 && m.start >= lo && m.end <= hi) folds.push(m);
  let looks = 0;
  let bytes = 0;
  for (const m of cands) {
    if (looks >= EXTRA_LOOKS || bytes >= EXTRA_BYTES || found.length >= MAX_ITEMS) break;
    if (found.some((f) => (f.m.start <= m.start && m.end <= f.m.end) || (m.start <= f.m.start && f.m.end <= m.end))) continue;
    if (!HAS_LINK.test(html.slice(m.start, Math.min(m.end, m.start + 4_000)))) continue;
    looks++;
    bytes += Math.min(m.end - m.start, SLICE_MAX);
    // a block of two branches' tables is two entries, as in the list
    for (const part of branchCards(html, [m])) {
      const item = htmlItem(html, part, base, pageUrl);
      const p = entryPrefix(item?.url);
      if (item && p && prefixes.has(p)) found.push({ m: part, item: withGroupName(html, folds, part, item) });
    }
  }
  return found.sort((x, y) => x.m.start - y.m.start);
}

// ───────────────────────────── markdown (Exa) ─────────────────────────────

export const MD_LINK = /\[([^\[\]\n]{0,300})\]\(\s*<?([^()<>\s]{1,2000})>?(?:\s+"[^"\n]{0,200}")?\s*\)/g;
const MD_IMAGE = /!\[([^\[\]\n]{0,300})\]\(\s*[^()\s]{0,2000}(?:\s+"[^"\n]{0,200}")?\s*\)/g;
const MD_ENTRY = /^\s{0,8}(?:[-*+•]|(\d{1,4})[.)])\s+(.+)$/;
const MD_ROW = /^\s{0,3}\|(.+)\|\s*$/;
const MD_HEADING = /^\s{0,3}#{2,5}\s+(.+)$/;

export function stripImages(s: string): string {
  return s.replace(MD_IMAGE, (_m, alt: string) => (meaningful(alt) ? alt : ""));
}

/** a link's group: its host + first path segment ("스시자로.site/clinic") */
function prefixOf(u: URL): string {
  const seg = u.pathname.split("/").filter(Boolean);
  return `${u.hostname}/${seg.length > 1 ? seg[0] : ""}`;
}

/** a markdown line's name: up to the first separator ("✓", "·", " - ", " / "), else up to the first number */
function cutName(plain: string): string {
  const s = stripRank(plain);
  let cut = s.search(/\s*(?:[✓✔|·•—–]|\s-\s|\s\/\s|:\s)/);
  if (cut <= 1) cut = s.search(/\s\d/);
  return cleanLabel(cut > 1 ? s.slice(0, cut) : s, cut > 1 ? NAME_CHARS : 40);
}

type MdLink = { u: URL; label: string };

/** a markdown line's links to other pages (10 at most); tel:, mailto: and contact links go to `contacts` */
function mdLinks(body: string, pageUrl: URL, contacts: Collector): MdLink[] {
  const links: MdLink[] = [];
  MD_LINK.lastIndex = 0;
  for (let m = MD_LINK.exec(body); m && links.length < 10; m = MD_LINK.exec(body)) {
    const href = m[2] ?? "";
    if (schemeContact(href, contacts, m[1] ?? "")) continue;
    const u = resolve(href, pageUrl);
    if (!u || samePage(u, pageUrl)) continue;
    const hit = fromHref(u, m[1] ?? "");
    if (hit) contacts.add(hit.kind, hit.c);
    else links.push({ u, label: (m[1] ?? "").replace(LINK_SUFFIX, "").trim() });
  }
  return links;
}

/** a line's words: its links' labels that name something, emphasis marks off */
const mdPlain = (body: string) =>
  body
    .replace(MD_LINK, (_m, label: string) => (meaningful(label) && !nothing(label.trim()) ? label : ""))
    .replace(/[*_`]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** the link a line is about: its first one with a name, else its first one */
const mainLink = (links: MdLink[]) => links.find((l) => meaningful(l.label) && !nothing(l.label)) ?? links[0];

/** lines between two links of one card, at most */
const CARD_GAP = 12;

interface MdEntry {
  item: ListItem;
  line: number;
  /** the page it links to ("" without a link) */
  key: string;
  /** a line of its own kind (a list entry, a table row, a heading), not a bare link: two of them are two entries */
  own: boolean;
}

interface MdHeading {
  line: number;
  name: string;
}

/** a card's plate: its lot's number first, then the road ("15-1", "98-1왕십리로", "3-9 성수일로3길") */
const LOT_PLATE = /^\d{1,4}-\d{1,4}(?:\s?[가-힣][가-힣\d]{0,10}(?:로|길))?$|^\d{1,4}\s?[가-힣][가-힣\d]{0,10}(?:로|길)$/;

/**
 * Cards Exa wrote as a few links to one page, a heading over them or between them ("### 1. 수서역 환승주차장" over
 * "[공영주차장 / …](p)", "[1시간 3,840원 …](p)", "[입구: …](p)"; "[프롤라 카페](p)", "#### 프롤라", "[서울특별시 …](p)"):
 * one entry each. A card is links to one page a few lines apart, with only text, headings and other kinds of links (a
 * map) between them; two list entries, rows or headings in a row linking to one page stay two (two branches sharing one
 * site). A card is named by its heading (the last one after the card before it, else the first one after its links
 * that no card took) when most cards have one, each its own words (a heading that repeats, "추천 포인트", is a label);
 * a page linked again further down (a ranking, a footer) takes no heading. Else a card is named by its first link that
 * is not an address ("연무장길 37-30" — see addressOnly); an address left as the name, or beside it, is the card's area.
 * An entry named by an address alone takes the heading right above it all the same.
 */
function mdCards(best: MdEntry[], lines: string[], lineUrl: Map<number, string>, heads: MdHeading[], cardsOnly: boolean): { cards: { item: ListItem; lines: number[] }[]; made: boolean } {
  type Run = { members: MdEntry[]; start: number; end: number; head?: MdHeading; again?: boolean };
  const runs: Run[] = [];
  const links = [...lineUrl.keys()]; // in line order
  // a page's kind: its host and first path segment, as the groups (a shop's Instagram or map link is no other card)
  const kinds = new Map<string, string>();
  const kindOf = (key: string) => {
    let k = kinds.get(key);
    if (k === undefined) {
      try {
        k = prefixOf(new URL(key));
      } catch {
        k = "";
      }
      kinds.set(key, k);
    }
    return k;
  };
  const other = (l: number, key: string) => {
    const k = lineUrl.get(l)!;
    return k !== key && kindOf(k) === kindOf(key);
  };
  // the last line before `line` linking to another page of its kind than `key`, after `floor` (else `floor`)
  const lastOther = (floor: number, line: number, key: string) => {
    let a = 0;
    let z = links.length;
    while (a < z) {
      const mid = (a + z) >> 1;
      if (links[mid]! < line) a = mid + 1;
      else z = mid;
    }
    for (let k = a - 1; k >= 0 && links[k]! > floor; k--) if (other(links[k]!, key)) return links[k]!;
    return floor;
  };
  // the first line after `line` linking to another page of its kind than `key`, before `ceil` (else `ceil`)
  const nextOther = (line: number, ceil: number, key: string) => {
    let a = 0;
    let z = links.length;
    while (a < z) {
      const mid = (a + z) >> 1;
      if (links[mid]! <= line) a = mid + 1;
      else z = mid;
    }
    for (let k = a; k < links.length && links[k]! < ceil; k++) if (other(links[k]!, key)) return links[k]!;
    return ceil;
  };
  for (const x of best) {
    const cur = runs.at(-1);
    const last = cur?.members.at(-1);
    // bare links a few lines apart join a card; two list entries, rows or headings linking to one page (two branches
    // sharing one site) stay two, and so does the page linked again further down
    const fits = cur && last && x.key && x.key === last.key && x.line - last.line <= CARD_GAP && !(x.own && cur.members.some((m) => m.own));
    if (fits) cur.members.push(x);
    else runs.push({ members: [x], start: lastOther(last?.line ?? -1, x.line, x.key), end: 0 });
  }
  const all = runs;
  // a page's card linked again later (a ranking, a "where to compare" list, a footer) takes no heading: the section's
  // is no name of it
  const met = new Set<string>();
  for (const r of all) {
    const k = r.members[0]!.key;
    if (k && met.has(k)) r.again = true;
    met.add(k);
  }
  // where each card ends: before the next line linking to another page of its kind, or the next card
  all.forEach((r, k) => {
    const last = r.members.at(-1)!;
    r.end = nextOther(last.line, all[k + 1]?.members[0]!.line ?? lines.length, last.key);
  });
  // each card's heading: the last one after the card before it, before its last link; a card without one takes the
  // first heading after its links, before it ends, that no card took ("- [西梅田駅](p)", "## 大美会クリニック 梅田院", …).
  // A card opening with its lot's plate ("[15-1](p)" over "### 셉템버 템퍼쳐", "[98-1왕십리로](p)") starts there: a
  // heading above that is the card's before it, whose links the copy lost
  const taken = new Set<number>();
  let h = 0;
  for (const r of all) {
    const end = r.members.at(-1)!.line;
    while (h < heads.length && heads[h]!.line < end) h++;
    const c = heads[h - 1];
    if (c && c.line > r.start && !(c.line < r.members[0]!.line && LOT_PLATE.test(r.members[0]!.item.name))) {
      r.head = c;
      taken.add(c.line);
    }
  }
  h = 0;
  for (const r of all) {
    if (r.head) continue;
    const last = r.members.at(-1)!.line;
    while (h < heads.length && heads[h]!.line <= last) h++;
    const c = heads[h];
    if (c && c.line < r.end && !taken.has(c.line)) {
      r.head = c;
      taken.add(c.line);
    }
  }
  const usable = (n: string) => n.length <= 80 && !addressOnly(n) && !plainLabel(n) && !GENERIC.test(n);
  const uses = new Map<string, number>();
  for (const r of all) if (r.head) uses.set(r.head.name, (uses.get(r.head.name) ?? 0) + 1);
  const named = (r: Run) => !!r.head && !r.again && usable(r.head.name) && uses.get(r.head.name) === 1;
  const firsts = all.filter((r) => !r.again);
  const byHeads = firsts.filter(named).length * 2 >= firsts.length;
  // cards made: links folded into one, or named by their headings
  const made = byHeads || all.some((r) => r.members.length > 1);
  if (cardsOnly && !made) return { cards: [], made };
  const out = all.map((r) => {
    const ms = r.members;
    const addressed = ms.every((m) => addressOnly(m.item.name));
    // the heading right above an address alone (only blank lines between them) or between its links; not one after it
    const above = !!r.head && r.head.line < ms.at(-1)!.line && (r.head.line > ms[0]!.line || lines.slice(r.head.line + 1, ms[0]!.line).every((l) => !l.trim()));
    const head = named(r) && (byHeads || (addressed && above)) ? r.head : undefined;
    const base = ms.find((m) => !addressOnly(m.item.name)) ?? ms[0]!;
    if (ms.length === 1 && !head) {
      const it = base.item;
      if (addressOnly(it.name) && !it.area) {
        const a = areaValue(it.name);
        if (a) it.area = a;
      }
      return { item: it, lines: [base.line] };
    }
    const item: ListItem = { ...base.item };
    if (head) {
      // a heading's tags as a link's: "【2026年最新】" off, a place tag to the area
      const bare = untagged(cleanLabel(head.name, NAME_CHARS), ms.map((m) => `${m.item.name}\n${m.item.text ?? ""}`).join("\n"), item.area);
      item.name = bare.name;
      if (bare.area) item.area = bare.area;
    }
    for (const m of ms) {
      item.url ??= m.item.url;
      item.domain ??= m.item.domain;
      item.tel ??= m.item.tel;
      item.contacts ??= m.item.contacts;
      item.links ??= m.item.links;
      if (!item.area && addressOnly(m.item.name)) {
        const a = areaValue(m.item.name);
        if (a) item.area = a;
      }
      item.area ??= m.item.area;
    }
    if (!item.area) delete item.area;
    // the other links' words are the card's text; its name and its area are fields of their own
    const seen = new Set([item.name, item.area ?? ""]);
    const parts: string[] = [];
    for (const m of ms) {
      // a name cut short ("…を独自…") is in its own text whole
      const cut = m.item.name.replace(/…$/, "");
      for (const piece of [m.item.text?.startsWith(cut) ? "" : m.item.name, m.item.text ?? ""]) {
        // the card's name in front of a link's words is said once ("프롤라 카페" under "프롤라" → "카페")
        const t = piece.startsWith(`${item.name} `) ? piece.slice(item.name.length + 1) : piece;
        if (t && !seen.has(t)) {
          seen.add(t);
          parts.push(t);
        }
      }
    }
    const text = cleanLabel(parts.join(" · "), TEXT_CHARS);
    if (text) item.text = text;
    else delete item.text;
    return { item, lines: [...ms.map((m) => m.line), ...(head ? [head.line] : [])] };
  });
  return { cards: out, made };
}

/**
 * Entries of Exa's markdown text: list / table / heading lines with a link, the biggest same-prefix group (≥ 6). Without
 * them, lines that open with a link count too, and a list comes back only when they make cards (see mdCards): a page of
 * bare links is otherwise linkGroupItems' to read.
 */
/** a row label saying where a place is or how to reach it ("주소", "📞 전화번호", "住所"; not 予約 / 費用 of a review) */
const RECORD_WHERE = /^(?:住所|所在地|場所|アクセス|最寄り?駅|電話(?:番号)?|TEL|주소|위치|소재지|가까운\s?역|전화(?:\s?번호)?|연락처|address|location|phone|tel|access)$/i;
/** a list line "label: value" ("- 📍 주소: 서울 서초구 …", "- 電話番号：03-…"): its label (symbols off) and value */
const MD_LABEL_ROW = /^\s{0,8}(?:[-*+•]|\d{1,4}[.)])\s+([^:：\n]{1,24}?)\s{0,2}[:：]\s{0,2}(\S.{0,400})$/;

/**
 * A place written as label rows under its heading ("### 1. 서초초교앞 유료 민영 주차장" over "- 📍 주소: …", "- 📞 전화번호: …",
 * "- 30분당: 3,000원"): one entry per heading with two label rows or more, one of them saying where it is or how to reach
 * it (RECORD_WHERE); named by the heading, its rows' words its text, the first link under it (a map's) its link
 */
function mdRecords(rows: MdEntry[], lines: string[], heads: MdHeading[], lineHref: Map<number, string>): { item: ListItem; lines: number[] }[] {
  const out: { item: ListItem; lines: number[] }[] = [];
  // the lines' links in line order, read once from the start as the headings go down
  const hrefs = [...lineHref];
  let at = 0;
  let h = -1;
  let block: MdEntry[] = [];
  const close = () => {
    const head = heads[h];
    if (!head || block.length < 2) return;
    const rows = block.map((r) => {
      const m = MD_LABEL_ROW.exec(stripImages(lines[r.line]!));
      return { r, label: m ? m[1]!.replace(/[\p{S}\p{P}]+/gu, " ").replace(/\s+/g, " ").trim() : "", value: m ? m[2]!.replace(/[*_`]{1,3}/g, "").trim() : "" };
    });
    const labelled = rows.filter((x) => x.label && meaningful(x.value));
    if (labelled.length < 2 || !labelled.some((x) => RECORD_WHERE.test(x.label))) return;
    const end = heads[h + 1]?.line ?? head.line + CARD_GAP * 4;
    // the first page linked under the heading
    while (at < hrefs.length && hrefs[at]![0] <= head.line) at++;
    const url = at < hrefs.length && hrefs[at]![0] < end ? hrefs[at]![1] : undefined;
    const tel = block.find((r) => r.item.tel)?.item.tel;
    // its rows' words, the phone row aside (the entry's tel)
    const said = rows.filter((x) => !(tel && x.r.item.tel === tel && /^(?:電話(?:番号)?|TEL|전화(?:\s?번호)?|연락처|phone|tel)$/i.test(x.label)));
    const text = cleanLabel(said.map((x) => (x.label ? `${x.label}: ${x.value}` : [x.r.item.name, x.r.item.text].filter(Boolean).join(" "))).join(" · "), TEXT_CHARS);
    const item = { name: cleanLabel(stripRank(head.name), NAME_CHARS) } as ListItem;
    const area = block.find((r) => r.item.area)?.item.area;
    if (tel) item.tel = tel;
    if (area) item.area = area;
    if (url) item.url = url;
    const contacts = [...new Set(block.flatMap((r) => r.item.contacts ?? []))].slice(0, ITEM_CONTACTS);
    if (contacts.length) item.contacts = contacts;
    if (text) item.text = text;
    const bare = untagged(item.name, text, item.area);
    item.name = bare.name;
    if (bare.area) item.area = bare.area;
    out.push({ item, lines: block.map((r) => r.line) });
  };
  for (const r of rows) {
    let k = h;
    while (k + 1 < heads.length && heads[k + 1]!.line < r.line) k++;
    if (k !== h) {
      close();
      h = k;
      block = [];
    }
    if (h >= 0) block.push(r);
  }
  close();
  return out;
}

export function markdownItems(md: string, pageUrl: URL): ItemList | null {
  const first = mdList(md, pageUrl, false);
  return first.list ?? (first.cards ? mdList(md, pageUrl, true).list : null);
}

/** `cards`: whether bare links could make cards here (a heading without a link, or one page linked twice a card apart) */
function mdList(md: string, pageUrl: URL, cardsOnly: boolean): { list: ItemList | null; cards: boolean } {
  const lines = md.split("\n");
  const groups = new Map<string, MdEntry[]>();
  const plainList: MdEntry[] = [];
  // a table's header row (the row above its separator row) is not an entry; its area column names the rows' area
  const headers = new Set<number>();
  // the page each line links to (its main link), and the headings without a link: cards' titles (see mdCards)
  const lineUrl = new Map<number, string>();
  // the link each such line shows, whole (see mdRecords)
  const lineHref = new Map<number, string>();
  const heads: MdHeading[] = [];
  let areaCol = -1;
  // the table's header labels (see headPieces)
  let mdHeads: string[] = [];
  let prevRow: string[] | null = null;
  for (let i = 0; i < lines.length && i < 20_000; i++) {
    // one space for every whitespace run: the patterns below never rescan a long one
    const line = stripImages(lines[i]!).replace(/[^\S\n]+/g, " ");
    if (/^\s{0,3}\|[\s:|-]+\|\s*$/.test(line)) {
      // a table's separator row
      if (prevRow) {
        headers.add(i - 1);
        areaCol = prevRow.findIndex((c) => isAreaHeader(c.replace(MD_LINK, "$1")));
        // a header with a link is a row of values too (one of a place)
        mdHeads = prevRow.some((c) => c.includes("](")) ? [] : headsOf(prevRow.map(mdPlain));
      }
      prevRow = null;
      continue;
    }
    const row = MD_ROW.exec(line)?.[1];
    const cells = row ? row.split("|").slice(0, 60) : null;
    if (!cells) {
      areaCol = -1;
      mdHeads = [];
    }
    prevRow = cells;
    const entry = MD_ENTRY.exec(line);
    let body = entry?.[2] ?? row?.replace(/ ?\| ?/g, " · ") ?? MD_HEADING.exec(line)?.[1] ?? (cardsOnly && /^\s{0,3}\[/.test(line) && line.includes("](") ? line : undefined);
    if (!body) {
      // a line of links that is no entry: the page it links to still bounds the cards around it (see mdCards), the key
      // the line has as an entry of the cards pass
      const main = line.includes("](") ? mainLink(mdLinks(line, pageUrl, new Collector(2))) : undefined;
      if (main) {
        lineUrl.set(i, main.u.origin + main.u.pathname);
        lineHref.set(i, displayUrl(main.u));
      }
      continue;
    }
    // "1. 1야마모토 …", "2. 2 KOYOMI …": a ranking's own number repeated after the list number
    if (entry?.[1] && body.startsWith(entry[1]) && !/^\d/.test(body.slice(entry[1].length))) body = body.slice(entry[1].length).trimStart();
    const contacts = new Collector(2);
    const links = mdLinks(body, pageUrl, contacts);
    const plain = mdPlain(body);
    const main = mainLink(links);
    if (main) {
      lineUrl.set(i, main.u.origin + main.u.pathname);
      lineHref.set(i, displayUrl(main.u));
    } else if (!entry && !cells && !contacts.out.phones.length && !body.includes("](")) {
      // emphasis marks off, an underscore inside a word kept ("셉템버 템퍼쳐_9월의온도")
      const t = stripRank(body.replace(/[*`]{1,3}/g, "").replace(/(^|\s)_{1,3}|_{1,3}(?=\s|$)/g, "$1").replace(/\s+/g, " ").trim());
      if (meaningful(t) && heads.length < 5_000) heads.push({ line: i, name: t });
      continue;
    }
    if (!meaningful(plain)) continue;
    textContacts(plain, contacts);
    const name = main && meaningful(main.label) && !nothing(main.label) && main.label.length <= 80 ? stripRank(main.label) : cutName(plain);
    if (!meaningful(name)) continue;
    const item = { name: cleanLabel(name, NAME_CHARS) } as ListItem;
    const tel = telKey(contacts.out.phones[0]?.value);
    if (tel) item.tel = tel;
    const cell = !entry && cells && areaCol >= 0 ? cells[areaCol] : undefined;
    const cellPlain = cell ? cell.replace(MD_LINK, "$1").replace(/[*_`]{1,3}/g, "") : "";
    const area = (cellPlain ? areaValue(cellPlain) : "") || areaIn(plain);
    if (area && area !== item.name) item.area = area;
    const bare = untagged(item.name, plain, item.area);
    item.name = bare.name;
    if (bare.area) item.area = bare.area;
    if (main) {
      item.url = displayUrl(main.u);
      if (!sameSite(main.u.hostname, pageUrl.hostname)) item.domain = displayHost(main.u.hostname);
    }
    // a table row under its header's labels: each value after the name with its column's label (see headPieces)
    const parts = !entry && cells && mdHeads.length === cells.length ? cells.map(mdPlain) : null;
    const at = parts ? nameCell(parts, name) : -1;
    const text = at >= 0 ? labelledText(headPieces(parts!, mdHeads, at), name, item.area) : entryText(plain, name, item.area);
    if (text) item.text = text;
    const mainKey = main ? main.u.origin + main.u.pathname : "";
    const others = links.filter((l) => l !== main && l.u.origin + l.u.pathname !== mainKey).slice(0, ITEM_LINKS);
    if (others.length) item.links = others.map((l) => ({ label: cleanLabel(meaningful(l.label) ? l.label : displayHost(l.u.hostname), 40), url: displayUrl(l.u) }));
    const cs = contactStrings(contacts.out, ITEM_CONTACTS);
    if (cs.length) item.contacts = cs;
    if (main) {
      const k = prefixOf(main.u);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push({ item, line: i, key: main.u.origin + main.u.pathname, own: !!(entry || cells || MD_HEADING.test(line)) });
    } else if (!MD_HEADING.test(line)) plainList.push({ item, line: i, key: "", own: true });
  }
  if (headers.size) {
    for (const [k, g] of groups) groups.set(k, g.filter((x) => !headers.has(x.line)));
    const kept = plainList.filter((x) => !headers.has(x.line));
    plainList.length = 0;
    plainList.push(...kept);
  }
  let best: MdEntry[] = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
  // places written as label rows under their headings, when no linked list is there: two of them make a list
  if (best.length < MIN_ITEMS && !cardsOnly) {
    const records = mdRecords(plainList, lines, heads, lineHref);
    if (records.length >= 2) {
      const { items, cut } = dedupe(records.map((x) => x.item));
      if (items.length >= 2) return { list: { items, source: "markdown", lines: new Set(records.flatMap((x) => x.lines)), ...(cut ? { cut } : {}) }, cards: false };
    }
  }
  // a table or list without links (a price or phone table) when no linked list is there
  if (best.length < MIN_ITEMS && plainList.length >= MIN_ITEMS && plainList.some((x) => x.item.contacts)) best = plainList;
  if (best.length >= MIN_ITEMS) {
    // the cards pass gives no cards back unless bare links made some
    const { cards } = mdCards(best, lines, lineUrl, heads, cardsOnly);
    const { items, cut } = dedupe(cards.map((x) => x.item));
    if (items.length >= MIN_ITEMS) return { list: { items, source: "markdown", lines: new Set(cards.flatMap((x) => x.lines)), ...(cut ? { cut } : {}) }, cards: false };
  }
  if (cardsOnly || heads.length) return { list: null, cards: !cardsOnly };
  // a card's links (the same page within CARD_GAP lines) are the only other way bare links make cards
  const near = new Map<string, number>();
  for (const [i, k] of lineUrl) {
    if (i - (near.get(k) ?? -Infinity) <= CARD_GAP) return { list: null, cards: true };
    near.set(k, i);
  }
  return { list: null, cards: false };
}

// ───────────────────────────── links fallback ─────────────────────────────

/** ≥ 6 same-site content links sharing a path prefix (/clinic/a, /clinic/b, …) → entries with a name and a URL */
export function linkGroupItems(links: { label: string; url: URL }[], pageUrl: URL): ItemList | null {
  const groups = new Map<string, { label: string; url: URL }[]>();
  for (const l of links) {
    if (!sameSite(l.url.hostname, pageUrl.hostname) || !meaningful(l.label) || nothing(l.label)) continue;
    const seg = l.url.pathname.split("/").filter(Boolean);
    if (seg.length < 2) continue;
    const k = `/${seg.slice(0, seg.length - 1).join("/")}/`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(l);
  }
  let best: { label: string; url: URL }[] = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
  if (best.length < MIN_ITEMS) return null;
  const { items, cut } = dedupe(
    best.map((l) => {
      const item = { name: untagged(cleanLabel(stripRank(l.label), NAME_CHARS), "", undefined).name, url: displayUrl(l.url) } as ListItem;
      // a link named by an address alone ("연무장길 37-30"): no other name beside it here, the address is its area too
      const area = addressOnly(item.name) ? areaValue(item.name) : "";
      if (area) item.area = area;
      return item;
    }),
  );
  return items.length >= MIN_ITEMS ? { items, source: "links", ...(cut ? { cut } : {}) } : null;
}
