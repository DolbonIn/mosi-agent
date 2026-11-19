/**
 * Fetch one public web page for web_read.
 *
 * - http(s) only, default ports only; every hop's host is resolved and vetted by @pickle/agent `assertPublicUrl`
 *   (no loopback, private, link-local, cloud metadata, reserved or multicast address; `.local`/`.internal` names)
 * - the connection is pinned to the vetted IP (Host header + TLS SNI keep the name), so a DNS answer that changes
 *   between the check and the connect can't swap in a private address
 * - redirects are followed by hand, at most 5, and each target is vetted again
 * - 2 MB body cap (after decompression) and an 8 s cap per page
 * - an honest User-Agent (never a browser's); no cookies, no login, no JS
 * - one request at a time per host, ≥ 1 s apart; a host that answered 403 or 429 is not asked again for 10 minutes
 *   (429: its Retry-After, clamped to 1 min … 1 h), and the refusal is returned as is — nor read through Exa then
 *
 * Only the URL is sent: no user id, thread id or name.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { assertPublicUrl } from "@pickle/agent";
import { doFetch, sleep } from "../http";

/** honest: an automated reader acting for one person, not a browser */
export const WEB_USER_AGENT = "web-reader/1.0 (personal assistant; reads a page a person asked for)";
export const READ_MAX_BYTES = 2 * 1024 * 1024;
export const READ_TIMEOUT_MS = 8_000;
/** web_read's own read of the page while no list is in hand (Exa's copy has none, or there is none): a slow site's wait */
export const SLOW_READ_MS = 15_000;
export const MAX_REDIRECTS = 5;
const DEFAULT_HOST_GAP_MS = 1_000;
export const BLOCK_MS = 10 * 60_000;
const RETRY_AFTER_MIN_MS = 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

export type ReadFailureKind =
  | "invalid_url"
  | "blocked_address"
  | "blocked"
  | "login_required"
  | "rate_limited"
  | "not_found"
  | "http"
  | "too_many_redirects"
  | "unsupported_type"
  | "timeout"
  | "aborted"
  | "network";

export interface ReadFailure {
  kind: ReadFailureKind;
  /** Korean, shown to the model and in the chip */
  message: string;
  status?: number;
  /** a refusal remembered from an earlier call (no request was made this time) */
  remembered?: boolean;
}

export interface FetchedPage {
  /** final URL after redirects (ASCII / punycode host) */
  url: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  /** the body was longer than the cap and was cut */
  truncated: boolean;
  redirects: number;
}

export type FetchPageResult = { ok: true; page: FetchedPage } | { ok: false; error: ReadFailure };

// ───────────────────────────── seams (tests) ─────────────────────────────

type Lookup = (host: string) => Promise<string[]>;
let lookupImpl: Lookup | null = null;

/** Inject a DNS resolver (tests). `null` restores node:dns. */
export function setWebLookup(fn: Lookup | null): void {
  lookupImpl = fn;
}

/** IPv4 first: the pinned connect uses the first vetted address and not every network routes IPv6 */
async function resolveHost(host: string): Promise<string[]> {
  const addrs = lookupImpl ? await lookupImpl(host) : (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
  return [...addrs.filter((a) => !a.includes(":")), ...addrs.filter((a) => a.includes(":"))];
}

let clock: () => number = Date.now;
let hostGapMs = DEFAULT_HOST_GAP_MS;
let readTimeoutMs = READ_TIMEOUT_MS;
let slowReadMs = SLOW_READ_MS;
const hosts = new Map<string, { chain: Promise<void>; last: number }>();
const refused = new Map<string, { until: number; error: ReadFailure }>();

const resetHooks: (() => void)[] = [];

/** web_read's page cache registers here, so one reset clears everything */
export function onWebReadReset(fn: () => void): void {
  resetHooks.push(fn);
}

/** tests: forget hosts, refusals and cached pages; optionally fake the clock, the per-host gap and web_read's waits */
export function resetWebReadState(o: { clock?: () => number; hostGapMs?: number; readTimeoutMs?: number; slowReadMs?: number } = {}): void {
  hosts.clear();
  refused.clear();
  clock = o.clock ?? Date.now;
  hostGapMs = o.hostGapMs ?? DEFAULT_HOST_GAP_MS;
  readTimeoutMs = o.readTimeoutMs ?? READ_TIMEOUT_MS;
  slowReadMs = o.slowReadMs ?? SLOW_READ_MS;
  for (const fn of resetHooks) fn();
}

/** the clock web_read's state runs on (tests fake it) */
export const webReadNow = (): number => clock();

/** how long web_read waits for the page: READ_TIMEOUT_MS, SLOW_READ_MS while no list is in hand (tests shorten them) */
export const readWaits = (): { read: number; slow: number } => ({ read: readTimeoutMs, slow: slowReadMs });

// ───────────────────────────── helpers ─────────────────────────────

/** "스시자로.site/x", "example.com" → "https://…"; anything with a scheme is left for the URL check */
export function normalizeInputUrl(raw: string): string {
  const s = raw.trim().replace(/[​-‏⁠﻿]/g, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d+(\/|$)/.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  return `https://${s}`;
}

function failure(kind: ReadFailureKind, message: string, status?: number): ReadFailure {
  return status === undefined ? { kind, message } : { kind, message, status };
}

function fromUrlCheck(e: unknown): ReadFailure {
  const m = e instanceof Error ? e.message : "";
  if (m === "invalid URL") return failure("invalid_url", "주소 형식이 올바르지 않아요");
  if (m.startsWith("blocked scheme")) return failure("invalid_url", "http·https 주소만 읽을 수 있어요");
  if (m.startsWith("URLs with credentials")) return failure("invalid_url", "아이디·비밀번호가 들어간 주소는 열지 않아요");
  if (m.startsWith("only default ports")) return failure("invalid_url", "기본 포트(80·443) 주소만 읽을 수 있어요");
  if (m === "host did not resolve") return failure("network", "사이트 주소를 찾을 수 없어요");
  if (m.startsWith("blocked")) return failure("blocked_address", "내부·사설 네트워크 주소는 열 수 없어요");
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ENOTFOUND" || code === "ENODATA" || code === "EAI_AGAIN" || code === "EAI_NONAME") return failure("network", "사이트 주소를 찾을 수 없어요");
  return failure("network", "사이트 주소를 확인하지 못했어요");
}

function classifyFetchError(e: unknown, timedOut: boolean, timeoutMs = READ_TIMEOUT_MS): ReadFailure {
  if (timedOut) return failure("timeout", `페이지 응답이 너무 늦어요 (${Math.max(1, Math.floor(timeoutMs / 1000))}초 초과)`);
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError") return failure("timeout", "페이지 응답이 너무 늦어요");
  if (name === "AbortError") return failure("aborted", "요청이 취소됐어요");
  // the error text may echo the pinned URL: keep only the class
  return failure("network", "사이트에 연결하지 못했어요");
}

function race<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** one request at a time per host, ≥ hostGapMs between the end of one and the start of the next */
async function politely<T>(host: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  let h = hosts.get(host);
  if (!h) {
    if (hosts.size > 1000) hosts.clear();
    h = { chain: Promise.resolve(), last: 0 };
    hosts.set(host, h);
  }
  const prev = h.chain;
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  // the next caller waits for the previous one too, even if this one gives up early
  h.chain = prev.then(() => mine);
  try {
    await race(prev, signal);
    const gap = h.last + hostGapMs - clock();
    if (gap > 0) await sleep(gap, signal);
    return await fn();
  } finally {
    h.last = clock();
    release();
  }
}

function retryAfterMs(v: string | null): number {
  if (!v) return BLOCK_MS;
  const secs = Number(v);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - Date.now();
  if (!Number.isFinite(ms)) ms = BLOCK_MS;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}

/** refusals are kept per site: "www.example.com" and "example.com" are one */
const siteKey = (host: string): string => host.toLowerCase().replace(/^www\./, "");

function remember(host: string, error: ReadFailure, ms: number): void {
  if (refused.size > 1000) refused.clear();
  refused.set(siteKey(host), { until: clock() + ms, error });
}

function knownRefusal(host: string): ReadFailure | null {
  const known = refused.get(siteKey(host));
  return known && known.until > clock() ? { ...known.error, remembered: true } : null;
}

/** The URL with its host replaced by the vetted IP; Host header / TLS SNI keep the real name. */
function pinned(u: URL, address: string): { url: string; host: string; tls?: { serverName: string } } {
  const p = new URL(u.toString());
  p.hostname = address.includes(":") ? `[${address}]` : address;
  return { url: p.toString(), host: u.host, ...(u.protocol === "https:" ? { tls: { serverName: u.hostname } } : {}) };
}

const READABLE_TYPE = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))/;

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      truncated = true;
      reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= out.length) break;
  }
  return { bytes: out, truncated };
}

/** a site that refused us (403 / 429) lately, with that refusal */
export function refusedBy(host: string): ReadFailure | null {
  return knownRefusal(host);
}

/** remember a refusal reported for a site by another reader (Exa's crawler was refused there) */
export function rememberRefusal(host: string, error: ReadFailure, ms = BLOCK_MS): void {
  remember(host, error, ms);
}

/**
 * Vet a URL without fetching it (before handing it to Exa): http(s), default port, no credentials, a public address
 * (DNS resolved and checked like a direct read), and not refused by its host lately.
 */
export async function vetUrl(raw: string, signal: AbortSignal): Promise<{ ok: true; url: URL; address: string } | { ok: false; error: ReadFailure }> {
  const v = await publicUrl(raw, signal);
  if (!v.ok) return v;
  const known = refusedBy(v.url.hostname);
  return known ? { ok: false, error: known } : v;
}

/** http(s), default port, no credentials, a public address (DNS resolved and checked) — nothing is fetched */
export async function publicUrl(raw: string, signal: AbortSignal): Promise<{ ok: true; url: URL; address: string } | { ok: false; error: ReadFailure }> {
  try {
    const { url, address } = await race(assertPublicUrl(normalizeInputUrl(raw), resolveHost), signal);
    return { ok: true, url, address };
  } catch (e) {
    return { ok: false, error: signal.aborted ? classifyFetchError(e, false) : fromUrlCheck(e) };
  }
}

// ───────────────────────────── fetch ─────────────────────────────

/** `vetted`: the first URL as vetUrl() just checked it (its address is pinned as is; every redirect is vetted anew) */
export async function fetchPage(raw: string, signal: AbortSignal, o: { maxBytes?: number; timeoutMs?: number; acceptLanguage?: string; vetted?: { url: URL; address: string } } = {}): Promise<FetchPageResult> {
  const opts = { maxBytes: o.maxBytes ?? READ_MAX_BYTES, timeoutMs: o.timeoutMs ?? READ_TIMEOUT_MS, acceptLanguage: o.acceptLanguage ?? "ko,en;q=0.8,ja;q=0.6" };
  let url = normalizeInputUrl(raw);
  // every host on the way: a refusal at the end of a redirect chain holds for the hosts that led there too
  const chain: string[] = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    let address: string;
    if (hop === 0 && o.vetted && o.vetted.url.toString() === url) {
      ({ url: u, address } = o.vetted);
    } else {
      try {
        ({ url: u, address } = await race(assertPublicUrl(url, resolveHost), signal));
      } catch (e) {
        return { ok: false, error: signal.aborted ? classifyFetchError(e, false) : fromUrlCheck(e) };
      }
    }
    const host = u.hostname.toLowerCase();
    chain.push(host);
    const known = knownRefusal(host);
    if (known) {
      spread(host, chain);
      return { ok: false, error: known };
    }
    const r = await fetchHop(u, address, hop, signal, opts);
    if ("next" in r) {
      url = r.next;
      continue;
    }
    if (!r.ok && (r.error.kind === "blocked" || r.error.kind === "rate_limited")) spread(host, chain);
    return r;
  }
  return { ok: false, error: failure("too_many_redirects", `리디렉션이 너무 많아요 (${MAX_REDIRECTS}회 초과)`) };
}

/** the refusal remembered for `host` also for the hosts that redirected there */
function spread(host: string, chain: string[]): void {
  const rec = refused.get(siteKey(host));
  if (!rec) return;
  for (const h of chain) if (!refused.has(siteKey(h)) || refused.get(siteKey(h))!.until < rec.until) refused.set(siteKey(h), rec);
}

/** One request to a vetted address. Its own timeout starts when its turn at the host comes, and covers headers and body. */
async function fetchHop(u: URL, address: string, hop: number, signal: AbortSignal, o: { maxBytes: number; timeoutMs: number; acceptLanguage: string }): Promise<FetchPageResult | { next: string }> {
  const host = u.hostname.toLowerCase();
  const pin = pinned(u, address);
  const timer = new AbortController();
  let timedOut = false;
  let t: ReturnType<typeof setTimeout> | undefined;
  const drop = (res: Response) => void res.body?.cancel().catch(() => {});
  try {
    let res: Response;
    try {
      res = await politely(host, signal, () => {
        t = setTimeout(() => {
          timedOut = true;
          timer.abort(new DOMException("timed out", "TimeoutError"));
        }, o.timeoutMs);
        return doFetch(pin.url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.any([signal, timer.signal]),
          headers: {
            Host: pin.host,
            "User-Agent": WEB_USER_AGENT,
            Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
            "Accept-Language": o.acceptLanguage,
          },
          ...(pin.tls ? { tls: pin.tls } : {}),
        } as RequestInit);
      });
    } catch (e) {
      return { ok: false, error: classifyFetchError(e, timedOut, o.timeoutMs) };
    }
    const status = res.status;
    const location = res.headers.get("location");
    if (status >= 300 && status < 400 && location) {
      drop(res);
      try {
        return { next: new URL(location, u).toString() };
      } catch {
        return { ok: false, error: failure("invalid_url", "리디렉션 주소가 올바르지 않아요", status) };
      }
    }
    if (status === 401 || status === 407) {
      drop(res);
      return { ok: false, error: failure("login_required", "로그인해야 볼 수 있는 페이지예요. 로그인을 대신하지는 않아요", status) };
    }
    if (status === 403) {
      drop(res);
      const error = failure("blocked", "이 사이트가 자동 읽기를 막고 있어요 (403). 우회하지 않아요", status);
      remember(host, error, BLOCK_MS);
      return { ok: false, error };
    }
    if (status === 429) {
      const ms = retryAfterMs(res.headers.get("retry-after"));
      drop(res);
      const error = failure("rate_limited", "이 사이트가 요청을 너무 많이 받았다고 해요 (429). 잠시 뒤에 다시 읽을 수 있어요", status);
      remember(host, error, ms);
      return { ok: false, error };
    }
    if (status === 404 || status === 410) {
      drop(res);
      return { ok: false, error: failure("not_found", "페이지가 없어요 (삭제됐거나 주소가 바뀐 것 같아요)", status) };
    }
    if (status < 200 || status >= 300) {
      drop(res);
      return { ok: false, error: failure("http", `페이지를 열 수 없어요 (HTTP ${status})`, status) };
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !READABLE_TYPE.test(contentType)) {
      drop(res);
      const what = contentType.includes("pdf") ? "PDF" : contentType.startsWith("image/") ? "이미지" : contentType.split(";")[0];
      return { ok: false, error: failure("unsupported_type", `읽을 수 없는 형식이에요 (${what})`, status) };
    }
    try {
      const { bytes, truncated } = await readCapped(res, o.maxBytes);
      return { ok: true, page: { url: u.toString(), status, contentType, bytes, truncated, redirects: hop } };
    } catch (e) {
      return { ok: false, error: classifyFetchError(e, timedOut, o.timeoutMs) };
    }
  } finally {
    if (t) clearTimeout(t);
  }
}
