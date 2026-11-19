/**
 * web_read's reader: Exa's copy of the page first, the page itself when that falls short, and whichever caught more
 * of the page's list.
 *
 * 1. The URL is vetted like a direct read (http(s), default port, no credentials, a public address) before it goes
 *    anywhere. A page read in the last 10 minutes comes from the cache (reading on with `from` / `itemsFrom` costs no
 *    request) — but when only Exa's copy answered because the page itself timed out or sent a 5xx (`direct`), a new
 *    read (`again`) asks the page once more, with Exa's copy from the cache; otherwise a site that refused lately gets
 *    its refusal back. The cache keeps the CACHE_MAX pages used
 *    last (a hit counts as a use): a long list paged between other reads stays, however many other pages come between.
 * 2. Exa (POST /contents, EXA_API_KEY; only the URL without its #fragment is sent) returns the page as markdown with
 *    its links. URLs that look like they carry a token, a password or a session (?token=, ?sig=, ?pwd=, …) and
 *    share-link hosts (Google Docs / Drive, Dropbox, OneDrive, SharePoint, Box, iCloud, WeTransfer, Zoom), where the
 *    URL itself is the key, are never handed to Exa: they are read directly.
 * 3. The page itself is fetched too (SSRF-pinned, honest UA, 2 MB / 8 s caps, net.ts), after Exa's copy or without
 *    one. While no list is in hand (Exa's copy has none, or there is no copy) a slow page gets up to 15 s instead of
 *    8, within the caller's time (`until`), in the same one request: a region article's server once took over 8 s
 *    and its 6 clinics were lost to Exa's copy without them. A list drawn by script is only in Exa's copy, one Exa's
 *    rendering cut or turned into sentences only in the page (region articles of 3 to 5 clinics came back from Exa
 *    with no entries). When neither found a list, Exa's copy answers as it is (a thin one, or one without links,
 *    takes the page's links and text along). When the page can't be read (a timeout, a 5xx), Exa's copy answers. The
 *    result with more of the page's own places wins: entries to follow up (a link, a phone or another contact), each
 *    place once (its phone, else its link), leaving out links to the site's pages beside this one (its other
 *    articles and regions, the redirects it sends readers through). Then the one with more of them with a phone,
 *    then more entries to follow up, then more entries (the page on a tie). The list is the winner's alone (the
 *    other's extra entries were its menus, region pages, files and the same places under a detail page's name);
 *    contacts and links are merged.
 * 4. A site that refused (403 / 429, or asked for a login) — us or Exa's crawler — is not read through the other
 *    route: the refusal comes back as it is (no copy from the other route) and 403 / 429 are remembered for 10
 *    minutes, for the site with and without "www." and for every host of the redirect chain.
 */
import { getJson, exa as exaProvider, providerKeys } from "./providers";
import { Collector, contactCount, type Contacts } from "./contacts";
import { readMarkdown, readPage, type ReadablePage } from "./extract";
import { decodeBody, sameSite, stripHash } from "./html";
import { MIN_ITEMS, statedIn } from "./items";
import { fetchPage, onWebReadReset, publicUrl, READ_MAX_BYTES, readWaits, refusedBy, rememberRefusal, webReadNow, type ReadFailure } from "./net";

export interface ReadDoc {
  /** final URL (ASCII / punycode host) */
  url: string;
  redirected: boolean;
  /** where the page came from ("exa+direct": the list from one, the text around it from the other) */
  source: "exa" | "direct" | "exa+direct";
  /** the direct body was longer than 2 MB and was cut */
  truncated: boolean;
  page: ReadablePage;
  /** entries each route found, when both were read */
  compared?: { exa: number; direct: number };
  /**
   * only Exa's copy answered because the page itself timed out (or the caller's time ran out) or sent a 5xx, after
   * `waitedMs` (a slow or flaky site: worth reading again later, one site at a time). 403 / 429 / a login are
   * refusals instead (no copy), a 404 / a redirect loop / another failure leaves no mark.
   */
  direct?: { failed: "timeout" | "5xx"; waitedMs: number };
}

export type ReadOutcome = { ok: true; doc: ReadDoc; cached: boolean } | { ok: false; error: ReadFailure };

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 30;
const EXA_TIMEOUT_MS = 8_000;
/** Exa crawls a page live when its copy is older than this */
const EXA_MAX_AGE_HOURS = 72;
const EXA_LIVECRAWL_MS = 6_000;
const EXA_MAX_CHARS = 150_000;
const EXA_AUTH_PAUSE_MS = 60 * 60_000;
const EXA_RATE_PAUSE_MS = 2 * 60_000;
/** less text than this (and no list) is a thin copy: read the page itself */
const THIN_CHARS = 400;
/** fewer follow-up links than this in Exa's copy (and no list): read the page itself for its links */
const FEW_LINKS = 3;

/** `at`: when the page was read (the 10 minutes run from it). Map order is the order of use: the least recently used first */
const cache = new Map<string, { at: number; doc: ReadDoc }>();
let exaPausedUntil = 0;
onWebReadReset(() => {
  cache.clear();
  exaPausedUntil = 0;
});

/** query parameters that look like a secret, a password or a session: such a URL is read directly, never sent to Exa */
const SECRET_PARAM =
  /(?:^|[?&])(?:[\w-]*(?:token|secret|signature|passw(?:or)?d|passcode|session|auth|apikey|api_key|access_key|credential|ticket|nonce|hmac)[\w-]*|key|sig|sign|code|otp|sid|pw|pwd|pass|jwt|rlkey)=/i;
/** share-link hosts: the URL is the key to a private file or meeting */
const CAPABILITY_HOST =
  /(?:^|\.)(?:docs\.google\.com|drive\.google\.com|dropbox\.com|dropboxusercontent\.com|onedrive\.live\.com|1drv\.ms|sharepoint\.com|box\.com|icloud\.com|wetransfer\.com|we\.tl|zoom\.us)$/i;

export function exaEligible(u: URL): boolean {
  return !SECRET_PARAM.test(u.search) && !CAPABILITY_HOST.test(u.hostname) && providerKeys(exaProvider) !== null && exaPausedUntil <= webReadNow();
}

/** the site refused this read: 403 / 429 (ours or Exa's crawler), or a login */
const refusal = (e: ReadFailure) => e.kind === "blocked" || e.kind === "rate_limited" || e.kind === "login_required";

type ExaRead = { ok: true; url: string; title: string; text: string } | { ok: false; refusal: ReadFailure | null };

interface ExaContentsBody {
  results?: { url?: string; title?: string | null; text?: string }[];
  statuses?: { id?: string; status?: string; error?: { tag?: string; httpStatusCode?: number | null } | null }[];
}

function noFragment(u: URL): string {
  const c = new URL(u.toString());
  c.hash = "";
  return c.toString();
}

/** Exa's error tags without an HTTP code: "CRAWL_FORBIDDEN", "ROBOTS_DISALLOWED", "ACCESS_DENIED", "RATE_LIMITED" … */
const BLOCKED_TAG = /(?:^|_)(?:FORBIDDEN|BLOCKED|ROBOTS|DENIED)(?:_|$)/i;
const RATE_TAG = /(?:^|_)(?:RATE|TOO_MANY)(?:_|$)/i;

/** Exa's copy of one page. `refusal` is set when the site refused Exa's crawler (or the page is gone): don't fetch it */
async function exaRead(u: URL, signal: AbortSignal): Promise<ExaRead> {
  const keys = providerKeys(exaProvider);
  if (!keys) return { ok: false, refusal: null };
  const r = await getJson({
    id: "exa",
    label: "Exa",
    origin: "https://api.exa.ai",
    url: "https://api.exa.ai/contents",
    method: "POST",
    headers: { "x-api-key": keys[0]! },
    body: { urls: [noFragment(u)], text: { maxCharacters: EXA_MAX_CHARS, linkStyle: "full", verbosity: "full" }, maxAgeHours: EXA_MAX_AGE_HOURS, livecrawlTimeout: EXA_LIVECRAWL_MS },
    signal: AbortSignal.any([signal, AbortSignal.timeout(EXA_TIMEOUT_MS)]),
  });
  if (!r.ok) {
    // Exa's own trouble (key, credits, rate, outage): the page is still there to read directly
    if (r.error.kind === "auth") exaPausedUntil = webReadNow() + EXA_AUTH_PAUSE_MS;
    if (r.error.kind === "rate") exaPausedUntil = webReadNow() + EXA_RATE_PAUSE_MS;
    return { ok: false, refusal: null };
  }
  const body = r.body as ExaContentsBody;
  const st = Array.isArray(body.statuses) ? body.statuses[0] : undefined;
  if (st && st.status === "error") {
    const tag = typeof st.error?.tag === "string" ? st.error.tag : "";
    const code = st.error?.httpStatusCode || (BLOCKED_TAG.test(tag) ? 403 : RATE_TAG.test(tag) ? 429 : 0);
    const host = u.hostname;
    if (code === 403) {
      const error: ReadFailure = { kind: "blocked", message: "이 사이트가 자동 읽기를 막고 있어요 (403). 우회하지 않아요", status: 403 };
      rememberRefusal(host, error);
      return { ok: false, refusal: error };
    }
    if (code === 429) {
      const error: ReadFailure = { kind: "rate_limited", message: "이 사이트가 요청을 너무 많이 받았다고 해요 (429). 잠시 뒤에 다시 읽을 수 있어요", status: 429 };
      rememberRefusal(host, error);
      return { ok: false, refusal: error };
    }
    if (code === 401 || code === 407) return { ok: false, refusal: { kind: "login_required", message: "로그인해야 볼 수 있는 페이지예요. 로그인을 대신하지는 않아요", status: code } };
    if (code === 404 || code === 410) return { ok: false, refusal: { kind: "not_found", message: "페이지가 없어요 (삭제됐거나 주소가 바뀐 것 같아요)", status: code } };
    return { ok: false, refusal: null };
  }
  const res = Array.isArray(body.results) ? body.results[0] : undefined;
  if (!res || typeof res.text !== "string" || !res.text.trim()) return { ok: false, refusal: null };
  let url = u.toString();
  try {
    const got = new URL(res.url ?? "");
    if ((got.protocol === "https:" || got.protocol === "http:") && sameSite(got.hostname, u.hostname)) url = got.toString();
  } catch {
    /* keep the asked URL */
  }
  return { ok: true, url, title: typeof res.title === "string" ? res.title : "", text: res.text };
}

const thin = (p: ReadablePage) => p.items.length === 0 && p.text.length < THIN_CHARS;
/** entries one can follow up: with a link, a phone or another contact (bullets of plain text are not) */
const reachable = (p: ReadablePage) => p.items.filter((it) => it.url || it.tel || it.contacts?.length).length;
/** entries that say where they are, in a list of places (half of it at least: a site's menu says nowhere, a clinic's
 * own label rows say it once, on its 住所 row) */
const located = (p: ReadablePage) => {
  const n = p.items.filter((it) => it.area).length;
  return n * 2 >= p.items.length ? n : 0;
};

const segments = (u: URL) => u.pathname.split("/").filter(Boolean);

/**
 * a page of the same site in the same folder as this one (/blog/shinjuku-… beside /blog/tokyo-…, /prefectures27/
 * beside /prefectures13/, /blog/clinicfor-…-link?id3=… beside /blog/tokyo-…): the site's other articles, regions and
 * redirects, not a place this page lists (a directory's /clinic/902/ is not beside its /area/osaka/). One with a phone
 * is still a place (a chain's other branches). A site's top page has none: its links are what it lists.
 */
function besidePage(link: string, page: URL): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  if (!sameSite(u.hostname, page.hostname)) return false;
  const folder = (x: URL) => segments(x).slice(0, -1).join("/");
  return segments(page).length > 0 && folder(u) === folder(page);
}

/**
 * the page's own places in a read: entries to follow up, without links to the pages beside this one, each place once —
 * by its phone, else its link (Exa's copy can split one place into its name, address, phone and "details" lines, all
 * linking to the same page). 38 links of a blog's other articles and its redirects lose to 7 clinics' own sites; the
 * site's menu ("장소", "팝업스토어", "지도" …) has none: its 8 sections lose to 7 popup stores of Exa's copy.
 */
function places(p: ReadablePage, page: URL): { all: number; phoned: number } {
  const seen = new Set<string>();
  if (p.itemsMenu) return { all: 0, phoned: 0 };
  let phoned = 0;
  for (const it of p.items) {
    const contact = it.tel ?? it.contacts?.[0];
    if (!it.url && !contact) continue;
    if (!contact && besidePage(it.url!, page)) continue;
    const key = it.tel ? `t:${it.tel}` : it.url ? `u:${it.url.replace(/#.*$/, "").replace(/\/$/, "")}` : `c:${contact}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (it.tel) phoned++;
  }
  return { all: seen.size, phoned };
}

/** Exa's copy lost the page's links (menus and region lists drawn outside the text): the page itself has them */
const linkless = (p: ReadablePage) => p.items.length === 0 && p.links.length + p.pageLinks.length < FEW_LINKS;

function mergeContacts(a: Contacts, b: Contacts): Contacts {
  const c = new Collector();
  for (const src of [a, b]) for (const [k, list] of Object.entries(src) as [keyof Contacts, Contacts[keyof Contacts]][]) for (const x of list) c.add(k, x);
  return c.out;
}

function union<T extends { url: string }>(a: T[], b: T[], max: number): T[] {
  const seen = new Set(a.map((x) => x.url));
  return [...a, ...b.filter((x) => !seen.has(x.url))].slice(0, max);
}

function remember(key: string, doc: ReadDoc): void {
  const now = webReadNow();
  cache.delete(key);
  // pages past their 10 minutes go first, then the least recently used
  for (const [k, v] of cache) if (now - v.at >= CACHE_TTL_MS) cache.delete(k);
  for (const k of cache.keys()) {
    if (cache.size < CACHE_MAX) break;
    cache.delete(k);
  }
  cache.set(key, { at: now, doc });
}

/** a page read in the last 10 minutes, now the most recently used one (a hit does not make it fresher) */
function cached(key: string): ReadDoc | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  if (webReadNow() - hit.at >= CACHE_TTL_MS) return null;
  cache.set(key, hit);
  return hit.doc;
}

/** the page's own read failed in a way worth another try later (see ReadDoc.direct), or null */
function directFailure(e: ReadFailure): "timeout" | "5xx" | null {
  if (e.kind === "timeout" || e.kind === "aborted") return "timeout";
  return e.kind === "http" && (e.status ?? 0) >= 500 ? "5xx" : null;
}

/**
 * `until`: by when (webReadNow) the read should be over; a slow page's longer wait ends there (never below 8 s).
 * `again`: a new read (not reading on): a cached Exa copy marked `direct` tries the page once more.
 */
export async function readUrl(raw: string, signal: AbortSignal, o: { until?: number; again?: boolean } = {}): Promise<ReadOutcome> {
  const { until, again = false } = o;
  const vet = await publicUrl(raw, signal);
  if (!vet.ok) return vet;
  const key = stripHash(vet.url);
  // a page read lately (only vetted URLs are cached): reading on needs no request, even if the site refuses now
  const hit = cached(key);
  if (hit && !(again && hit.direct)) return { ok: true, doc: hit, cached: true };
  const known = refusedBy(vet.url.hostname);
  if (known) return { ok: false, error: known };

  // a new read of a page that timed out or sent a 5xx: Exa's copy from the cache (not asked for again), the page anew
  let viaExa: ReadDoc | null = null;
  if (hit) {
    const { direct: _failed, ...copy } = hit;
    viaExa = copy;
  } else if (exaEligible(vet.url)) {
    const e = await exaRead(vet.url, signal);
    if (!e.ok && e.refusal) return { ok: false, error: e.refusal };
    if (e.ok) viaExa = { url: e.url, redirected: false, source: "exa", truncated: false, page: readMarkdown(e.text, new URL(e.url), { title: e.title }) };
  }
  // Exa's copy found no list: the page is read too, its list may be there (Exa's copy of a region article listed its
  // clinics as sentences, the page lists them); if the page has none either, this copy answers as it is
  const plain = viaExa !== null && !thin(viaExa.page) && !linkless(viaExa.page) && viaExa.page.items.length < MIN_ITEMS;

  // no list in hand: a slow page is waited for longer (one request, never a second try), as the caller's time allows
  const waits = readWaits();
  const listed = viaExa !== null && viaExa.page.items.length >= MIN_ITEMS;
  const timeoutMs = listed ? waits.read : Math.max(waits.read, Math.min(waits.slow, until === undefined ? waits.read : until - webReadNow()));
  const asked = webReadNow();
  const d = await fetchPage(vet.url.toString(), signal, { maxBytes: READ_MAX_BYTES, timeoutMs, vetted: vet });
  if (!d.ok) {
    // the site refused us (403 / 429 / login): that is the answer, Exa's copy is not used to get around it.
    // Anything else (a timeout, a 5xx, a redirect loop): Exa's copy is the answer, marked when a later read may do
    // better (a timeout, a 5xx)
    if (viaExa && !thin(viaExa.page) && !refusal(d.error)) {
      const failed = directFailure(d.error);
      const doc: ReadDoc = failed ? { ...viaExa, direct: { failed, waitedMs: Math.max(0, webReadNow() - asked) } } : viaExa;
      remember(key, doc);
      return { ok: true, doc, cached: false };
    }
    return { ok: false, error: d.error };
  }
  const finalUrl = new URL(d.page.url);
  const direct: ReadDoc = {
    url: d.page.url,
    redirected: d.page.redirects > 0,
    source: "direct",
    truncated: d.page.truncated,
    page: readPage(decodeBody(d.page.bytes, d.page.contentType), finalUrl),
  };
  if (plain && direct.page.items.length === 0) {
    remember(key, viaExa!);
    return { ok: true, doc: viaExa!, cached: false };
  }
  let doc = direct;
  if (viaExa) {
    const ne = viaExa.page.items.length;
    const nd = direct.page.items.length;
    // the page's own places count: 208 plain bullets of Exa's copy lose to 19 linked clinics of the page, a blog's
    // 38 links to its other articles and redirects to 7 clinics' sites; on a tie the places with a phone, then the list
    // of no more entries than the title says ("… 2곳 비교": the page's 2 lots beat Exa's 6 pieces of them), then the
    // entries to follow up, then those that say where they are in a list of places (8 popup stores beat a menu of
    // 8 links in the page's body), then all entries
    const pe = places(viaExa.page, new URL(viaExa.url));
    const pd = places(direct.page, finalUrl);
    const stated = statedIn(direct.page.title || viaExa.page.title);
    // more entries than the title says are pieces of them (or more than the list)
    const fits = (p: ReadablePage) => (stated && p.items.length && p.items.length <= stated ? 1 : 0);
    const steps = [pe.all - pd.all, pe.phoned - pd.phoned, fits(viaExa.page) - fits(direct.page), reachable(viaExa.page) - reachable(direct.page), located(viaExa.page) - located(direct.page), ne - nd];
    const order = steps.find((x) => x !== 0) ?? 0;
    const exaWins = order > 0 || (thin(direct.page) && !thin(viaExa.page));
    const win = exaWins ? viaExa : direct;
    const other = exaWins ? direct : viaExa;
    // the list from the winner (the page on a tie); contacts and links from both; the longer text (intro, notes) —
    // the other's only if it left its list out too (a text with the list in it would repeat the items)
    const otherText = !thin(other.page) && other.page.text.length > win.page.text.length && (win.page.items.length === 0 || other.page.items.length > 0);
    const text = otherText ? other.page.text : win.page.text;
    const merged: ReadablePage = {
      ...win.page,
      text,
      contacts: mergeContacts(win.page.contacts, other.page.contacts),
      links: union(win.page.links, other.page.links, 8),
      pageLinks: union(win.page.pageLinks, other.page.pageLinks, 12),
      sources: union(win.page.sources, other.page.sources, 4),
      title: win.page.title || other.page.title,
      description: win.page.description || other.page.description,
    };
    const both = text !== win.page.text || merged.links.length > win.page.links.length || merged.pageLinks.length > win.page.pageLinks.length || merged.sources.length > win.page.sources.length || contactCount(merged.contacts) > contactCount(win.page.contacts);
    doc = { ...win, source: both ? "exa+direct" : win.source, page: merged, compared: { exa: ne, direct: nd } };
  }
  remember(key, doc);
  return { ok: true, doc, cached: false };
}
