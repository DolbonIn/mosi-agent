/**
 * Contact handles on a page: phones (KR / JP domestic, +CC international, Korean nationwide 15xx/16xx/18xx), emails
 * (also "abc [at] mail.com"), KakaoTalk ID / open chat / channel, Telegram, LINE, Instagram, WhatsApp and inquiry
 * forms — from links (tel:, mailto:, messenger URLs) and from the visible text. Untrusted page data.
 */
export interface Contact {
  value: string;
  url?: string;
  /** "link": from an href (tel:, mailto:, a known messenger URL); "text": from the visible text */
  source: "link" | "text";
}

export interface Contacts {
  phones: Contact[];
  emails: Contact[];
  kakao: Contact[];
  telegram: Contact[];
  line: Contact[];
  instagram: Contact[];
  whatsapp: Contact[];
  forms: Contact[];
}

const PER_KIND = 8;

export function emptyContacts(): Contacts {
  return { phones: [], emails: [], kakao: [], telegram: [], line: [], instagram: [], whatsapp: [], forms: [] };
}

export class Collector {
  readonly out = emptyContacts();
  private seen = new Map<keyof Contacts, Set<string>>();
  /** the key of each listed handle (same order as out[kind]) */
  private keys = new Map<keyof Contacts, string[]>();
  private banned = new Set<string>();
  constructor(private readonly perKind = PER_KIND) {}
  add(kind: keyof Contacts, c: Contact, key = (c.url ?? c.value).toLowerCase()): void {
    if (this.banned.has(`${kind} ${key}`)) return;
    const list = this.out[kind];
    let s = this.seen.get(kind);
    if (!s) this.seen.set(kind, (s = new Set()));
    let ks = this.keys.get(kind);
    if (!ks) this.keys.set(kind, (ks = []));
    if (s.has(key)) {
      // a link beats the same handle found in the text
      if (c.source === "link") {
        const i = ks.indexOf(key);
        if (i >= 0 && list[i]!.source === "text") list[i] = c;
      }
      return;
    }
    if (list.length >= this.perKind) return;
    s.add(key);
    ks.push(key);
    list.push(c);
  }
  /** a handle the page marks as not real ("02-0000-0000(임시번호)"): out, and not taken again */
  ban(kind: keyof Contacts, key: string): void {
    this.banned.add(`${kind} ${key}`);
    const ks = this.keys.get(kind);
    const i = ks ? ks.indexOf(key) : -1;
    if (i < 0) return;
    ks!.splice(i, 1);
    this.out[kind].splice(i, 1);
    this.seen.get(kind)?.delete(key);
  }
}

export const digitsOf = (s: string): string => s.replace(/\D/g, "");

/** KR / JP domestic numbers and +CC international ones; null when it doesn't look like a phone number */
export function phoneValue(raw: string, maxIntlDigits = 15): string | null {
  const s = raw.normalize("NFKC").replace(/[‐‑‒–—―ー−]/g, "-").replace(/\s+/g, " ").trim();
  const d = digitsOf(s);
  if (s.startsWith("+")) return d.length >= 8 && d.length <= maxIntlDigits && !/^\+0/.test(s) ? s : null;
  if (/^1[568]\d{2}-?\d{4}$/.test(s)) return s; // 1588-1234, 1600-…, 1800-… (not years like 1999-2026)
  if (/^0\d/.test(s) && d.length >= 9 && d.length <= 11) return s;
  return null;
}

/**
 * A number that only stands in for one: 02-0000-0000, 010-0000-0000, 000-000-0000 (two all-zero groups, or zeros for
 * the whole subscriber part: seven or more of one digit in a row), 010-1111-1111, anything with 12345678
 * (03-1234-5678, 010-1234-5678). Pages and templates print these; a model copies them as if real.
 */
export function placeholderPhone(value: string): boolean {
  const s = value.normalize("NFKC");
  const d = digitsOf(s);
  if (/(\d)\1{6}/.test(d) || d.includes("12345678")) return true;
  let zeros = 0;
  for (const g of s.split(/\D+/)) if (g.length >= 3 && /^0+$/.test(g)) zeros++;
  return zeros >= 2;
}

/** words that mark a number as not real: any of these next to it … */
const FAKE_STRONG =
  "임시\\s?(?:전화\\s?)?번호|가짜\\s?번호|더미(?:\\s?번호)?|예시\\s?번호|번호\\s?예시|샘플\\s?번호|dummy|placeholder|ダミー|記入例|(?:sample|example|fake)\\s(?:number|phone|tel)";
/** … and these only in brackets after it ("(예시)") or with ")" / ":" before it ("예) 010-…", "例：03-…") */
const FAKE_WEAK = "예시|샘플|예|sample|example|サンプル|例";
const FAKE_AFTER = new RegExp(`^\\s{0,2}(?:[(（［\\[※*]\\s{0,2}(?:(?:${FAKE_STRONG})[^)）］\\]]{0,6}[)）］\\]]?|(?:${FAKE_WEAK})\\s{0,2}[)）］\\]])|(?:${FAKE_STRONG}))`, "i");
const FAKE_BEFORE = new RegExp(`(?<![A-Za-z])(?:(?:${FAKE_STRONG})\\s{0,2}[)）］\\]]?|(?:${FAKE_WEAK})\\s{0,2}[)）］\\]:：])\\s{0,2}[:：]?\\s{0,2}[(（［\\[]?\\s{0,2}$`, "i");
/** a link label that says so ("02-0000-0000(임시번호)", "예시 번호") */
const FAKE_LABEL = new RegExp(`${FAKE_STRONG}|[(（［\\[]\\s{0,2}(?:${FAKE_WEAK})\\s{0,2}[)）］\\]]`, "i");
const LABEL_LOOK = 16;

/** the label next to t[start, end) that marks it as not real: [cut start, cut end) with the label, or null */
function fakeLabel(t: string, start: number, end: number): [number, number] | null {
  // only up to the next / previous digit: "02-0000-0000(임시번호) 02-555-1234" marks the first number alone
  let after = t.slice(end, end + LABEL_LOOK);
  const d = after.search(/\d/);
  if (d >= 0) after = after.slice(0, d);
  const a = FAKE_AFTER.exec(after);
  if (a) return [start, end + a[0].length];
  let before = t.slice(Math.max(0, start - LABEL_LOOK), start);
  const last = before.search(/\d\D*$/);
  if (last >= 0) before = before.slice(last + 1);
  const b = FAKE_BEFORE.exec(before);
  return b ? [start - (before.length - b.index), end] : null;
}

const PHONE_TEXT = [
  // +81 3-1234-5678, +82 10-1234-5678, +81-90-1234-5678, +82 (0)2 123 4567, +819012345678
  /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){1,5}(?![\w])/g,
  // 010-1234-5678, 02-123-4567, 03-1234-5678, 0120-123-456, 090 1234 5678, (02)123-4567
  /(?<![\w+.-])\(?0\d{1,4}\)?[ .-]?\d{1,4}[ .-]\d{3,4}(?![\w-])/g,
  // 1588-1234, 1644-…, 1800-… (Korean nationwide numbers; 19xx would be years)
  /(?<![\w+.-])1[568]\d{2}-\d{4}(?![\w-])/g,
];

const EMAIL_TEXT = /(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}(?![\w-])/g;
const NOT_EMAIL_TLD = /\.(png|jpe?g|gif|webp|svg|avif|ico|css|js)$/i;
const PLACEHOLDER_EMAIL = /@(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.com|sentry\.io)$/i;

export function emailValue(raw: string): string | null {
  const s = raw.trim().replace(/^mailto:/i, "").split("?")[0]!.trim();
  if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,24}$/.test(s)) return null;
  if (NOT_EMAIL_TLD.test(s) || PLACEHOLDER_EMAIL.test(s)) return null;
  return s;
}

/** "abc [at] mail.com", "abc(at)mail(dot)com", "abc ＠ mail.com" → "abc@mail.com" (only for matching) */
function deobfuscate(text: string): string {
  return text
    .replace(/\s{0,3}[[(（]\s{0,3}(?:at|골뱅이)\s{0,3}[\])）]\s{0,3}/gi, "@")
    .replace(/\s{0,3}[[(（]\s{0,3}dot\s{0,3}[\])）]\s{0,3}/gi, ".")
    .replace(/(\w)\s+@\s+(\w)/g, "$1@$2");
}

const INSTAGRAM_RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "accounts", "tv", "direct", "about", "legal", "developer", "web", "challenge", "s", "share"]);
const FORM_HOSTS = /^(forms\.gle|docs\.google\.com|form\.naver\.com|tally\.so|(?:[\w-]+\.)?typeform\.com|(?:form\.)?jotform\.com|forms\.office\.com|forms\.microsoft\.com|airtable\.com)$/i;

/** a messenger / social / form URL → its contact kind and value */
export function fromHref(u: URL, label: string): { kind: keyof Contacts; c: Contact } | null {
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  const seg = path.split("/").filter(Boolean);
  const href = u.toString();
  if (host === "open.kakao.com" && seg[0] === "o" && seg[1]) return { kind: "kakao", c: { value: "카카오톡 오픈채팅", url: href, source: "link" } };
  if (host === "open.kakao.com" && seg[0] === "me" && seg[1]) return { kind: "kakao", c: { value: `카카오톡 오픈프로필 ${seg[1]}`, url: href, source: "link" } };
  if (host === "pf.kakao.com" && seg[0]) return { kind: "kakao", c: { value: `카카오톡 채널 ${seg[0]}`, url: href, source: "link" } };
  if (host === "qr.kakao.com" && seg.length) return { kind: "kakao", c: { value: "카카오톡 QR", url: href, source: "link" } };
  if ((host === "t.me" || host === "telegram.me" || host === "telegram.dog") && seg[0] && seg[0] !== "share") {
    const name = seg[0] === "joinchat" || seg[0].startsWith("+") ? "텔레그램 초대 링크" : `@${seg[0]}`;
    return { kind: "telegram", c: { value: name, url: href, source: "link" } };
  }
  if (u.protocol === "tg:") {
    const d = u.searchParams.get("domain");
    return d ? { kind: "telegram", c: { value: `@${d}`, url: `https://t.me/${encodeURIComponent(d)}`, source: "link" } } : null;
  }
  if (host === "line.me" || host === "lin.ee" || host === "page.line.me" || host === "liff.line.me") {
    const id = /\/ti\/p\/(~?@?[\w.-]+)/.exec(path)?.[1] ?? (host === "page.line.me" ? seg[0] : undefined);
    return { kind: "line", c: { value: id ? `LINE ${id.replace(/^~/, "")}` : "LINE 친구 추가 링크", url: href, source: "link" } };
  }
  if (host === "instagram.com" && seg[0] && !INSTAGRAM_RESERVED.has(seg[0].toLowerCase()) && /^[A-Za-z0-9._]{1,30}$/.test(seg[0])) {
    return { kind: "instagram", c: { value: `@${seg[0]}`, url: `https://www.instagram.com/${seg[0]}/`, source: "link" } };
  }
  if (host === "wa.me" && seg[0] && /^\d{6,15}$/.test(seg[0])) return { kind: "whatsapp", c: { value: `+${seg[0]}`, url: href, source: "link" } };
  if (host === "api.whatsapp.com" || host === "chat.whatsapp.com") {
    const phone = u.searchParams.get("phone");
    return { kind: "whatsapp", c: { value: phone ? `+${digitsOf(phone)}` : "WhatsApp 그룹 링크", url: href, source: "link" } };
  }
  if (FORM_HOSTS.test(host) && (host !== "docs.google.com" || path.startsWith("/forms")) && (host !== "airtable.com" || /\/shr/.test(path))) {
    return { kind: "forms", c: { value: label || "문의 폼", url: href, source: "link" } };
  }
  return null;
}

function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** tel: / sms: / mailto: hrefs → a contact (true when the href was one of them, used or not) */
export function schemeContact(href: string, contacts: Collector, label = ""): boolean {
  if (/^(tel|sms):/i.test(href)) {
    let v = phoneValue(decoded(href.replace(/^(tel|sms):/i, "")).split(/[;,?]/)[0] ?? "");
    // "tel:0312345678" shown as "03-1234-5678": keep the way the page writes it
    const shown = label ? phoneValue(label.trim()) : null;
    if (v && shown && /^\+?\d+$/.test(v) && digitsOf(shown) === digitsOf(v)) v = shown;
    if (v && (placeholderPhone(v) || FAKE_LABEL.test(label))) contacts.ban("phones", digitsOf(v));
    else if (v) contacts.add("phones", { value: v, url: `tel:${v.replace(/[^\d+]/g, "")}`, source: "link" }, digitsOf(v));
    return true;
  }
  if (/^mailto:/i.test(href)) {
    const v = emailValue(decoded(href));
    if (v) contacts.add("emails", { value: v, source: "link" }, v.toLowerCase());
    return true;
  }
  return false;
}

const ID = "[A-Za-z0-9][A-Za-z0-9._-]{2,29}";
const TEXT_HANDLES: { kind: keyof Contacts; re: RegExp; fmt: (v: string) => string; url?: (v: string) => string }[] = [
  { kind: "kakao", re: new RegExp(`(?:카카오톡|카톡|카카오|kakao\\s?talk|kakao)\\s{0,3}(?:아이디|id)\\s{0,3}[:：]?\\s{0,3}@?(${ID})`, "gi"), fmt: (v) => `카카오톡 ID ${v}` },
  { kind: "kakao", re: new RegExp(`(?:카카오톡|카톡)\\s{0,3}[:：]\\s{0,3}@?(${ID})`, "gi"), fmt: (v) => `카카오톡 ID ${v}` },
  { kind: "kakao", re: new RegExp(`(?:카카오톡|카톡)\\s{0,3}채널\\s{0,3}[:：]?\\s{0,3}@(${ID})`, "gi"), fmt: (v) => `카카오톡 채널 @${v}` },
  { kind: "telegram", re: /(?:텔레그램|텔레|telegram|tg)\s{0,3}(?:아이디|id)?\s{0,3}[:：]?\s{0,3}@([A-Za-z][A-Za-z0-9_]{4,31})/gi, fmt: (v) => `@${v}`, url: (v) => `https://t.me/${v}` },
  { kind: "telegram", re: /(?:텔레그램|telegram)\s{0,3}(?:아이디|id)\s{0,3}[:：]?\s{0,3}([A-Za-z][A-Za-z0-9_]{4,31})/gi, fmt: (v) => `@${v}`, url: (v) => `https://t.me/${v}` },
  { kind: "line", re: new RegExp(`(?:LINE|라인|ライン)\\s{0,3}(?:id|아이디)\\s{0,3}[:：]?\\s{0,3}@?(${ID})`, "gi"), fmt: (v) => `LINE ${v}` },
  { kind: "instagram", re: /(?:인스타그램|인스타|instagram|insta)\s{0,3}(?:아이디|id)?\s{0,3}[:：]?\s{0,3}@([A-Za-z0-9._]{2,30})/gi, fmt: (v) => `@${v}`, url: (v) => `https://www.instagram.com/${v}/` },
  { kind: "whatsapp", re: /(?:whatsapp|왓츠앱)\s{0,3}[:：]?\s{0,3}(\+?\d[\d -]{7,18}\d)/gi, fmt: (v) => v.trim() },
];

/** text looked at for handles: the start and the end of a very long page (footers carry contacts) */
const SCAN_HEAD = 800_000;
const SCAN_TAIL = 200_000;

/** handles in visible text */
export function textContacts(text: string, contacts: Collector): void {
  const src = text.length > SCAN_HEAD + SCAN_TAIL ? `${text.slice(0, SCAN_HEAD)}\n${text.slice(-SCAN_TAIL)}` : text;
  // one space or one line break between words: no whitespace run for the patterns to rescan (\r, U+3000, tabs …)
  const t = src.normalize("NFKC").replace(/[^\S\n]+/g, " ").replace(/ ?\n[\s]*/g, "\n");
  for (const re of PHONE_TEXT) {
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      // the international pattern can run into a following number ("+81 3-1234-5678 2026"): drop trailing groups
      let cand = m[0];
      let v = phoneValue(cand, 13);
      for (let i = 0; !v && i < 2 && cand.startsWith("+") && /[ .-]\(?\d+\)?$/.test(cand); i++) {
        cand = cand.replace(/[ .-]\(?\d+\)?$/, "");
        v = phoneValue(cand, 13);
      }
      if (!v) continue;
      if (placeholderPhone(v) || fakeLabel(t, m.index, m.index + cand.length)) contacts.ban("phones", digitsOf(v));
      else contacts.add("phones", { value: v, source: "text" }, digitsOf(v));
    }
  }
  const de = deobfuscate(t);
  EMAIL_TEXT.lastIndex = 0;
  for (let m = EMAIL_TEXT.exec(de); m; m = EMAIL_TEXT.exec(de)) {
    const v = emailValue(m[0]);
    if (v) contacts.add("emails", { value: v, source: "text" }, v.toLowerCase());
  }
  for (const h of TEXT_HANDLES) {
    h.re.lastIndex = 0;
    for (let m = h.re.exec(t); m; m = h.re.exec(t)) {
      const v = (m[1] ?? "").replace(/[._-]+$/, "");
      if (v.length < 2) continue;
      const c: Contact = { value: h.fmt(v), source: "text" };
      if (h.url) c.url = h.url(v);
      contacts.add(h.kind, c, (c.url ?? c.value).toLowerCase());
    }
  }
}

/**
 * The text without placeholder phones and their label ("02-0000-0000(임시번호)", "예) 010-1234-5678"): what the text
 * still says, a model repeats. Positions are found on a same-length copy (full-width digits and dashes as ASCII).
 */
export function scrubPlaceholderPhones(text: string): string {
  if (!/[0-9０-９]{2}/.test(text)) return text;
  const t = text
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[‐‑‒–—―ー−]/g, "-")
    .replace(/[^\S\n]/g, " ");
  const cuts: [number, number][] = [];
  for (const re of PHONE_TEXT) {
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      let cand = m[0];
      let v = phoneValue(cand, 13);
      for (let i = 0; !v && i < 2 && cand.startsWith("+") && /[ .-]\(?\d+\)?$/.test(cand); i++) {
        cand = cand.replace(/[ .-]\(?\d+\)?$/, "");
        v = phoneValue(cand, 13);
      }
      if (!v) continue;
      const end = m.index + cand.length;
      const cut: [number, number] | null = fakeLabel(t, m.index, end) ?? (placeholderPhone(v) ? [m.index, end] : null);
      if (cut) cuts.push(cut);
    }
  }
  if (!cuts.length) return text;
  cuts.sort((x, y) => x[0] - y[0]);
  let out = "";
  let at = 0;
  for (const [a0, b] of cuts) {
    let a = Math.max(a0, at);
    if (b <= a) continue;
    // one space where the number stood: "전화 02-0000-0000 · 예약" → "전화 · 예약"
    if (a > 0 && t[a - 1] === " " && (b >= t.length || /[\s,.·)）]/.test(t[b]!))) a--;
    out += text.slice(at, a);
    at = b;
  }
  return out + text.slice(at);
}

/** a contact form on the page itself: a <textarea> or an email/tel field, and not a search box */
export function pageForms(html: string, pageUrl: URL): Contact[] {
  const out: Contact[] = [];
  const re = /<form\b([^<>]{0,2000})>/gi;
  let seen = 0;
  for (let m = re.exec(html); m && out.length < 2 && seen < 20; m = re.exec(html)) {
    seen++;
    const open = m[1] ?? "";
    // look at most 20 000 characters ahead for this form's end (bounded work per form, whatever the page)
    const chunk = html.slice(m.index + m[0].length, m.index + m[0].length + 20_000);
    const end = chunk.search(/<\/form\s*>/i);
    const inner = end >= 0 ? chunk.slice(0, end) : chunk;
    if (/role\s*=\s*["']?search/i.test(open)) continue;
    const contactish = /<textarea\b/i.test(inner) || /<input\b[^<>]{0,500}?\btype\s{0,3}=\s{0,3}["']?(email|tel)\b/i.test(inner);
    if (!contactish) continue;
    // the form is filled in on this page (its action is only where it posts to)
    out.push({ value: "이 페이지의 문의 폼", url: pageUrl.toString(), source: "link" });
  }
  return out;
}

/** total handles found (for the summary line) */
export function contactCount(c: Contacts): number {
  return Object.values(c).reduce((n, l: Contact[]) => n + l.length, 0);
}

/** handles as short strings ("+81-3-1234-5678", "info@x.jp", "LINE @abc", "카카오톡 오픈채팅 https://open.kakao.com/o/…") */
export function contactStrings(c: Contacts, max: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(c) as Contact[][]) {
    for (const x of list) {
      if (out.length >= max) return out;
      const linkOnly = x.url && !x.url.startsWith("tel:") && !x.value.includes(x.url) && !/^[@+\d]/.test(x.value);
      out.push(linkOnly ? `${x.value} ${x.url}` : x.value);
    }
  }
  return out;
}
