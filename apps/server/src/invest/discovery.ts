/**
 * New events found (B2d-2a · 2b; team-lead 0052 B2d, 1550, 1618, 1700, 1701; DD 1551): once a day from 07:00 KST the
 * server reads five public T1 calendars and puts what is coming in the calendar of each person who uses invest, as
 * author `code`.
 *
 * - Sources: the Federal Register's rules (one fixed query: the Industry and Security Bureau and USTR, significant rules
 *   with an effective date, the words semiconductor, export control, Section 232, Section 301), the Fed's FOMC meetings
 *   (the decision day, 14:00 ET), BLS's release calendar (CPI, the Employment Situation, PPI; 08:30 ET), BEA's (GDP,
 *   Personal Income and Outlays) and the Bank of Korea's MPC meetings (no time on the page, none given).
 * - Code only: no model, nobody's token. Access as every public source (sources.ts): the default User-Agent, one request
 *   at a time, a 403 or 429 rests that host until the next US market day and the run goes on without it (its result
 *   says 확인 불가); a body that is not its data rests it the same way. Nothing is fetched when the sources are off.
 * - Once a day: the KST day's row in invest_discovery is taken first (as the 08:00 report does), so a second beat or a
 *   restart reads nothing again that day. A run cut short is not retaken: the next day finds the same events.
 * - What goes in (team-lead 1647): the market's today onward; the macro calendars (FOMC, BLS) up to EVENT_SPAN_DAYS ahead
 *   (the calendar's own window, so the person's 200 stay theirs), the Federal Register up to EVENT_MAX_DAYS. Titles are the code's (DD
 *   1551): "미국 11월 CPI 발표" with the reference month only when the source writes it, "FOMC 금리 결정", "미국 수출통제
 *   규정 시행" / "미국 관세 규정 시행". Skipped without an error: the same day and title already there (the person's own
 *   too), one the person deleted (invest_event_dismissed, matched by source · item · symbol: team-lead 1712), a person at
 *   MAX_EVENTS. An item names one occurrence (team-lead 1712, DD 1711 · 1716): `fr:<document number>`, `fomc:<first
 *   day>`, `cpi:2026-11` · `pce:2026-10` (the reference month) or `ppi:2026-12-11` (the release day when no month is
 *   written), `gdp:2026Q3:third` (quarter, year and estimate, else the day), `mpc:<day>`.
 * - A source read whole and ok moves or drops the finds it no longer lists (team-lead 1700 1, reconcile below): a find
 *   moves when its item is listed on another day; a failed, resting or junk source changes nothing, and so does a kind
 *   (the item before ':') the source gave none of in the window (its shape more likely changed: DD 1753).
 * - Nothing announces a find (DD 1551 6): the calendar, the 08:00 report's events and D-1 show it, as any code event.
 * - Last, watched stocks' next earnings (B2d-2c, earnings.ts): a web search and one model proposal per search, every
 *   figure checked by code; its counts under `company` in the day's result.
 */
import type { InvestEventKind } from "@pickle/protocol";
import { civilDate, dayNumber, weekday } from "@pickle/quant";
import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import { errInfo } from "../log.ts";
import { etDate, kstDay, marketClock, marketDate, type Market } from "./calendar.ts";
import { createEvent, EVENT_MAX_DAYS, EVENT_SPAN_DAYS } from "./events.ts";
import { discoverEarnings, type EarningsResult } from "./earnings.ts";
import { SOURCE_TABLE, type DiscoverySource, type SourceGate } from "./sources.ts";

/** team-lead 1550 7: before the 08:00 report and D-1, every day (weekends and holidays too) */
export const DISCOVERY_AT_KST = "07:00";

export const FEDREG_URL = (fromDay: string) =>
  "https://www.federalregister.gov/api/v1/documents.json?" +
  [
    "per_page=100",
    "order=newest",
    "conditions[agencies][]=industry-and-security-bureau",
    "conditions[agencies][]=trade-representative-office-of-united-states",
    "conditions[type][]=RULE",
    "conditions[significant]=1",
    `conditions[effective_date][gte]=${fromDay}`,
    ...["document_number", "title", "abstract", "effective_on", "html_url", "agencies", "significant"].map((f) => `fields[]=${f}`),
  ].join("&");
export const FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
export const BLS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";

/** one event a source gives: `item` names that one occurrence and keys a person's deletion with the source and the symbol */
export interface Found {
  source: DiscoverySource;
  item: string;
  market: Market;
  day: string;
  time: string | null;
  kind: InvestEventKind;
  title: string;
  url: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthOf = (word: string): number | null => {
  const i = MONTHS.indexOf(word.trim().slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
};
const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (y: number, m: number, d: number): string | null => {
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const s = `${y}-${pad(m)}-${pad(d)}`;
  return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : null;
};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// ───────────────────────────── Federal Register (JSON API) ─────────────────────────────

const FR_WORDS = /semiconductor|export control|section 232|section 301/i;
const FR_TARIFF = /section 232|section 301|tariff|dut(y|ies)/i;
const USTR = "trade-representative-office-of-united-states";

interface FrDoc {
  document_number?: unknown;
  title?: unknown;
  abstract?: unknown;
  effective_on?: unknown;
  html_url?: unknown;
  agencies?: { slug?: unknown }[];
  significant?: unknown;
}

/** the API's `results`: significant rules with an effective date whose title or abstract has one of the words; null when the body is not its JSON */
export function parseFedRegister(body: string): Found[] | null {
  let j: { results?: unknown };
  try {
    j = JSON.parse(body) as { results?: unknown };
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || (j.results !== undefined && !Array.isArray(j.results))) return null;
  const out: Found[] = [];
  for (const d of (j.results ?? []) as FrDoc[]) {
    if (!d || typeof d !== "object" || d.significant !== true) continue;
    const num = typeof d.document_number === "string" ? d.document_number.trim() : "";
    const day = typeof d.effective_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.effective_on) ? d.effective_on : null;
    const url = typeof d.html_url === "string" && d.html_url.startsWith("https://www.federalregister.gov/") ? d.html_url : null;
    if (!/^[\w-]{1,40}$/.test(num) || !day || !url) continue;
    const words = `${typeof d.title === "string" ? d.title : ""} ${typeof d.abstract === "string" ? d.abstract : ""}`;
    if (!FR_WORDS.test(words)) continue;
    const ustr = (d.agencies ?? []).some((a) => a && a.slug === USTR);
    const tariff = ustr || FR_TARIFF.test(words);
    out.push({ source: "fedreg", item: `fr:${num}`, market: "US", day, time: null, kind: "policy", title: tariff ? "미국 관세 규정 시행" : "미국 수출통제 규정 시행", url });
  }
  return out;
}

/** whether the API gave every match (its `count` within this page): a cut list is never taken for what is gone (team-lead 1700 1) */
export function fedRegisterWhole(body: string): boolean {
  try {
    const j = JSON.parse(body) as { count?: unknown; results?: unknown };
    return !(typeof j.count === "number" && Array.isArray(j.results) && j.count > j.results.length);
  } catch {
    return false;
  }
}

// ───────────────────────────── FOMC calendar (HTML) ─────────────────────────────

/**
 * each year's "YYYY FOMC Meetings" panel: a meeting's month ("January", "Apr/May") and days ("27-28", "17-18*", "30-1");
 * the decision is its last day, 14:00 ET. Notation votes and unscheduled meetings (other words in the days) are left out.
 * null when the page has no panel at all (not the calendar).
 */
export function parseFomc(html: string): Found[] | null {
  const heads = [...html.matchAll(/(\d{4}) FOMC Meetings/g)];
  if (!heads.length) return null;
  const out: Found[] = [];
  heads.forEach((h, i) => {
    const year = Number(h[1]);
    const part = html.slice(h.index!, i + 1 < heads.length ? heads[i + 1]!.index : html.length);
    const months = [...part.matchAll(/fomc-meeting__month[^>]*>([\s\S]*?)<\/div>/g)].map((m) => text(m[1]!));
    const days = [...part.matchAll(/fomc-meeting__date[^>]*>([\s\S]*?)<\/div>/g)].map((m) => text(m[1]!));
    if (months.length !== days.length) return;
    months.forEach((mw, k) => {
      const dm = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*\*?$/.exec(days[k]!);
      if (!dm) return;
      const names = mw.split("/");
      const first = monthOf(names[0]!);
      const last = monthOf(names.at(-1)!);
      if (!first || !last) return;
      const endDay = Number(dm[2] ?? dm[1]);
      // "Dec/Jan 31-1" would end in the next year; the Fed has not met across a year end, still read it right
      const day = isoDay(last < first ? year + 1 : year, last, endDay);
      const start = isoDay(year, first, Number(dm[1])); // the meeting's first day names it (team-lead 1712)
      if (day && start) out.push({ source: "fomc", item: `fomc:${start}`, market: "US", day, time: "14:00", kind: "policy", title: "FOMC 금리 결정", url: FOMC_URL });
    });
  });
  return out;
}

// ───────────────────────────── ICS calendars: BLS, BEA ─────────────────────────────

const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December";
const REF_MONTH = new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{4})\\b`);
/** a release for two months ("October and November 2025") names neither: no month is guessed (DD 1551) */
const TWO_MONTHS = new RegExp(`\\b(${MONTH_NAMES})\\s+(and|through|-|–)\\s+(${MONTH_NAMES})\\b`, "i");
const QUARTER = /\b([1-4])(st|nd|rd|th) Quarter\b/i;

/** the reference month the event writes, from its summary or else its description; null for none or two */
function refMonth(summary: string, desc: string): { year: number; month: number } | null {
  if (TWO_MONTHS.test(summary) || TWO_MONTHS.test(desc)) return null;
  const ref = REF_MONTH.exec(summary) ?? REF_MONTH.exec(desc);
  const month = ref ? monthOf(ref[1]!) : null;
  return ref && month ? { year: Number(ref[2]), month } : null;
}
const monthly = (words: string) => (summary: string, desc: string) => {
  const r = refMonth(summary, desc);
  return r ? `미국 ${r.month}월 ${words} 발표` : `미국 ${words} 발표`;
};
/** the reference month names the release, its own year too; without one, the release day (team-lead 1712) */
const byMonth = (kind: string) => (summary: string, desc: string, day: string) => {
  const r = refMonth(summary, desc);
  return r ? `${kind}:${r.year}-${pad(r.month)}` : `${kind}:${day}`;
};
const GDP_QUARTER = /\b([1-4])(?:st|nd|rd|th) Quarter(?: and Year)? (\d{4})\b/i;
const GDP_ESTIMATE = /\((Advance|Second|Third|Initial|Updated) Estimate\)/i;
/** DD 1753: the estimates with a settled Korean word; Initial and Updated (2025) have none and get none */
const ESTIMATE_WORD: Readonly<Record<string, string>> = { advance: "속보치", second: "잠정치", third: "확정치" };
/** a GDP release names its quarter, year and estimate (`gdp:2026Q3:third`, DD 1716); without all three, its day */
const gdpKey = (summary: string, _desc: string, day: string) => {
  const q = GDP_QUARTER.exec(summary);
  const e = GDP_ESTIMATE.exec(summary);
  return q && e ? `gdp:${q[2]}Q${q[1]}:${e[1]!.toLowerCase()}` : `gdp:${day}`;
};

interface IcsItem {
  re: RegExp;
  /** the item: one occurrence (team-lead 1712) */
  key: (summary: string, desc: string, day: string) => string;
  title: (summary: string, desc: string) => string;
}
const BLS_ITEMS: readonly IcsItem[] = [
  { re: /^consumer price index\b/i, key: byMonth("cpi"), title: monthly("CPI") },
  { re: /^(the )?employment situation\b/i, key: byMonth("nfp"), title: monthly("고용보고서") },
  { re: /^producer price index\b/i, key: byMonth("ppi"), title: monthly("PPI") },
];
/** BEA: the national GDP release (not by state, county or Puerto Rico) and Personal Income and Outlays (PCE) */
const BEA_ITEMS: readonly IcsItem[] = [
  {
    re: /^(gdp \(|gross domestic product, [1-4](st|nd|rd|th) quarter)/i,
    key: gdpKey,
    title: (summary) => {
      const q = QUARTER.exec(summary);
      if (!q) return "미국 GDP 발표";
      const word = ESTIMATE_WORD[GDP_ESTIMATE.exec(summary)?.[1]?.toLowerCase() ?? ""];
      return `미국 ${q[1]}분기 GDP ${word ? `${word} ` : ""}발표`;
    },
  },
  { re: /^personal income and outlays\b/i, key: byMonth("pce"), title: monthly("PCE") },
];
export const BLS_PAGE = "https://www.bls.gov/schedule/news_release/";
export const BEA_URL = "https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics";
export const BEA_PAGE = "https://www.bea.gov/news/schedule";

const icsText = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

/** DTSTART in its three forms: a US Eastern wall time (TZID), UTC (Z), or a date alone */
function icsStart(params: string, value: string): { day: string; time: string | null } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const day = isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!day) return null;
  if (m[4] === undefined) return { day, time: null };
  if (m[7] === "Z") {
    const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    return { day: etDate(at), time: marketClock("US", at) };
  }
  // a wall time: read only when the event says US Eastern (TZID=US-Eastern / America/New_York); else not guessed
  if (!/TZID=(US-Eastern|America\/New_York)/i.test(params)) return null;
  return { day, time: `${m[4]}:${m[5]}` };
}

/** one calendar's listed items; null when the body is not a calendar */
function parseIcs(body: string, source: DiscoverySource, items: readonly IcsItem[], url: string): Found[] | null {
  if (!/BEGIN:VCALENDAR/.test(body)) return null;
  const lines = body.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: Found[] = [];
  let ev: Record<string, { params: string; value: string }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT" && ev) {
      const summary = icsText(ev.SUMMARY?.value ?? "");
      const desc = icsText(ev.DESCRIPTION?.value ?? "");
      const hit = items.find((b) => b.re.test(summary));
      const start = ev.DTSTART ? icsStart(ev.DTSTART.params, ev.DTSTART.value) : null;
      if (hit && start) out.push({ source, item: hit.key(summary, desc, start.day), market: "US", day: start.day, time: start.time, kind: "macro", title: hit.title(summary, desc), url });
      ev = null;
    } else if (ev) {
      const c = line.indexOf(":");
      if (c > 0) {
        const [name, ...params] = line.slice(0, c).split(";");
        ev[name!.toUpperCase()] = { params: params.join(";"), value: line.slice(c + 1) };
      }
    }
  }
  return out;
}

/** BLS: CPI, the Employment Situation and PPI; the title names the reference month only when the event writes one */
export const parseBlsIcs = (body: string) => parseIcs(body, "bls", BLS_ITEMS, BLS_PAGE);
/** BEA: GDP (`미국 3분기 GDP 발표`, the quarter as written) and PCE (`미국 10월 PCE 발표`, the month as written) */
export const parseBeaIcs = (body: string) => parseIcs(body, "bea", BEA_ITEMS, BEA_PAGE);

// ───────────────────────────── the Bank of Korea's MPC (HTML) ─────────────────────────────

export const BOK_URL = (year: number) => `https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755&pYear=${year}`;
const KO_WEEKDAYS = "일월화수목금토";

/**
 * the year's rate-decision meetings ("01월 15일(목)" rows under the page's "2026년"); no time on the page, so none (DD 1551:
 * nothing guessed). A row whose weekday does not match its date is left out. null when the page is not that year's list;
 * a list with no rows yet (next year's before it is set) is [].
 */
export function parseBok(html: string, year: number): Found[] | null {
  const head = /<h3>\s*(\d{4})년\s*<\/h3>/.exec(html);
  const at = html.indexOf("<caption>통화정책방향 회의</caption>");
  if (!head || Number(head[1]) !== year || at < 0) return null;
  const end = html.indexOf("</table>", at);
  const table = html.slice(at, end < 0 ? html.length : end);
  const out: Found[] = [];
  for (const m of table.matchAll(/<th scope="row">\s*(\d{1,2})월\s*(\d{1,2})일\s*\(([일월화수목금토])\)\s*<\/th>/g)) {
    const day = isoDay(year, Number(m[1]), Number(m[2]));
    if (!day || KO_WEEKDAYS[weekday(dayNumber(day))] !== m[3]) continue;
    out.push({ source: "bok", item: `mpc:${day}`, market: "KR", day, time: null, kind: "policy", title: "금통위 기준금리 결정", url: BOK_URL(year) });
  }
  return out;
}

// ───────────────────────────── the day's run ─────────────────────────────

interface Page {
  url: string;
  parse: (body: string) => Found[] | null;
  /** false when the page lists only part of what matches: its finds still go in, nothing is moved or dropped */
  whole?: (body: string) => boolean;
}
interface SourceDef {
  source: DiscoverySource;
  market: Market;
  pages: (now: number) => Page[];
  ahead: number;
}

/** the KST year's list, and the next year's only when the window reaches into it (team-lead 1701: two a day at most) */
function bokPages(now: number): Page[] {
  const today = kstDay(now);
  const year = Number(today.slice(0, 4));
  const years = Number(civilDate(dayNumber(today) + EVENT_SPAN_DAYS).slice(0, 4)) > year ? [year, year + 1] : [year];
  return years.map((y) => ({ url: BOK_URL(y), parse: (body: string) => parseBok(body, y) }));
}

/** team-lead 1647: the macro calendars up to EVENT_SPAN_DAYS, the Federal Register up to EVENT_MAX_DAYS */
const SOURCES: readonly SourceDef[] = [
  { source: "fedreg", market: "US", pages: (now) => [{ url: FEDREG_URL(etDate(now)), parse: parseFedRegister, whole: fedRegisterWhole }], ahead: EVENT_MAX_DAYS },
  { source: "fomc", market: "US", pages: () => [{ url: FOMC_URL, parse: parseFomc }], ahead: EVENT_SPAN_DAYS },
  { source: "bls", market: "US", pages: () => [{ url: BLS_URL, parse: parseBlsIcs }], ahead: EVENT_SPAN_DAYS },
  { source: "bea", market: "US", pages: () => [{ url: BEA_URL, parse: parseBeaIcs }], ahead: EVENT_SPAN_DAYS },
  { source: "bok", market: "KR", pages: bokPages, ahead: EVENT_SPAN_DAYS },
];

export interface DiscoveryResult {
  day: string;
  sources: Partial<Record<DiscoverySource, { code: string; found: number; text?: "확인 불가"; partial?: true; stale?: string[] }>>;
  added: number;
  skipped: number;
  /** finds a source read whole and ok no longer lists on their day: moved to the day it lists, or dropped (team-lead 1700 1) */
  moved: number;
  removed: number;
  /** B2d-2c: the earnings step's counts (`skipped: "no_search"` without a search, `error` when it threw) */
  company?: EarningsResult | { skipped: "no_search" | "no_model" } | { error: true };
}

/** what a source gave that falls in its window, from the market's today */
function inWindow(f: Found, now: number, ahead: number): boolean {
  const today = marketDate(f.market, now);
  return f.day >= today && dayNumber(f.day) - dayNumber(today) <= ahead;
}

const dismissed = (core: Core, userId: string, f: Found) =>
  !!core.db.sql
    .query("SELECT 1 FROM invest_event_dismissed WHERE user_id = $u AND source = $s AND item = $i AND symbol = ''")
    .get({ u: userId, s: f.source, i: f.item });

/**
 * team-lead 1700 1, for a source read whole and ok today: each of the person's finds from it (author code, still ahead,
 * inside the window) that the source no longer lists on its day moves to the day it now lists for the same item and
 * title, or goes when there is none (no deletion mark: nobody deleted it). A move onto a day where that title already
 * is (the person's own) drops the stale find instead. Past days and days past the window stay; the person's and the
 * model's rows have no disc_source and are never read here. A row of a kind (the item before ':') the source gave none
 * of today is held as it is: more likely the page changed shape than every date went (DD 1753); its kind is returned.
 */
const kindOf = (item: string) => item.split(":")[0]!;
function reconcile(core: Core, userId: string, s: SourceDef, finds: Found[], now: number): { moved: number; removed: number; held: string[] } {
  const today = marketDate(s.market, now);
  const last = civilDate(dayNumber(today) + s.ahead);
  const rows = core.db.sql
    .query("SELECT id, day, disc_item FROM invest_events WHERE user_id = $u AND disc_source = $s AND day >= $a AND day <= $b ORDER BY day, id")
    .all({ u: userId, s: s.source, a: today, b: last }) as { id: string; day: string; disc_item: string }[];
  const key = (item: string, day: string) => `${item} ${day}`;
  const listed = new Set(finds.map((f) => key(f.item, f.day)));
  const held = new Set(rows.map((r) => key(r.disc_item, r.day)));
  const fresh = finds.filter((f) => !held.has(key(f.item, f.day)) && !dismissed(core, userId, f));
  const kinds = new Set(finds.map((f) => kindOf(f.item)));
  const holdKinds = new Set<string>();
  let moved = 0;
  let removed = 0;
  for (const r of rows) {
    if (listed.has(key(r.disc_item, r.day))) continue;
    if (!kinds.has(kindOf(r.disc_item))) {
      holdKinds.add(kindOf(r.disc_item));
      continue;
    }
    const i = fresh.findIndex((f) => f.item === r.disc_item); // an item is one occurrence (team-lead 1712)
    const to = i < 0 ? null : fresh.splice(i, 1)[0]!;
    if (to) {
      try {
        core.db.sql.query("UPDATE invest_events SET day = $d, time = $t, updated_at = $n WHERE id = $id").run({ d: to.day, t: to.time, n: now, id: r.id });
        moved++;
        continue;
      } catch (err) {
        if (!(err instanceof Error && /UNIQUE constraint/.test(err.message))) throw err;
      }
    }
    core.db.sql.query("DELETE FROM invest_events WHERE id = $id").run({ id: r.id });
    removed++;
  }
  return { moved, removed, held: [...holdKinds] };
}

/** from 07:00 KST, once per KST day: the sources, then each invest user's calendar. null when not due or taken */
export async function discoverDay(core: Core, gate: SourceGate, now: number): Promise<DiscoveryResult | null> {
  if (!core.cfg.invest.sources) return null;
  if (marketClock("KR", now) < DISCOVERY_AT_KST) return null;
  const day = kstDay(now);
  const taken = core.db.sql.query("INSERT OR IGNORE INTO invest_discovery (day, state, started_at) VALUES ($d, 'running', $n)").run({ d: day, n: now }).changes === 1;
  if (!taken) return null;
  const result: DiscoveryResult = { day, sources: {}, added: 0, skipped: 0, moved: 0, removed: 0 };
  const found: Found[] = [];
  const whole: { def: SourceDef; finds: Found[] }[] = [];
  for (const s of SOURCES) {
    const kept: Found[] = [];
    let failed: string | null = null;
    let partial = false;
    for (const page of s.pages(now)) {
      // a failed page stops its source: no second request to that host today (team-lead 1701)
      const r = await gate.get(s.source, page.url);
      if (!r.ok) {
        failed = r.code;
        break;
      }
      const items = page.parse(r.text);
      if (!items) {
        gate.pauseForJunk(s.source);
        failed = "not_data";
        break;
      }
      if (page.whole && !page.whole(r.text)) partial = true;
      kept.push(...items.filter((f) => inWindow(f, now, s.ahead)));
    }
    found.push(...kept);
    if (failed) {
      result.sources[s.source] = { code: failed, found: kept.length, text: "확인 불가" };
      continue;
    }
    if (partial) {
      result.sources[s.source] = { code: "ok", found: kept.length, partial: true };
      continue;
    }
    result.sources[s.source] = { code: "ok", found: kept.length };
    whole.push({ def: s, finds: kept });
  }
  const users = (core.db.sql.query("SELECT user_id FROM invest_settings ORDER BY user_id").all() as { user_id: string }[]).map((r) => r.user_id);
  const stale = new Map<DiscoverySource, Set<string>>();
  for (const userId of users) {
    for (const w of whole) {
      const r = reconcile(core, userId, w.def, w.finds, now);
      result.moved += r.moved;
      result.removed += r.removed;
      for (const k of r.held) stale.set(w.def.source, (stale.get(w.def.source) ?? new Set<string>()).add(k));
    }
    for (const f of found) {
      if (dismissed(core, userId, f)) {
        result.skipped++;
        continue;
      }
      const src = SOURCE_TABLE[f.source];
      try {
        createEvent(core.db, userId, { market: f.market, day: f.day, time: f.time, kind: f.kind, title: f.title, source: src.name, sourceTier: "T1", confidence: src.grade, url: f.url }, "code", now, { source: f.source, item: f.item });
        result.added++;
      } catch (err) {
        // the same day and title already there (a moved find too), or the person's upcoming events at their cap: left as they are
        if (!(err instanceof HttpError)) core.log.error("invest discovery add failed", { err: errInfo(err) });
        result.skipped++;
      }
    }
  }
  for (const [source, kinds] of stale) {
    const list = [...kinds].sort();
    result.sources[source] = { ...result.sources[source]!, stale: list };
    core.log.warn("invest discovery: kinds the source gave none of, rows held", { source, kinds: list.join(" ") });
  }
  try {
    result.company = await discoverEarnings(core, now);
  } catch (err) {
    core.log.error("invest earnings failed", { err: errInfo(err) });
    result.company = { error: true };
  }
  core.db.sql.query("UPDATE invest_discovery SET state = 'done', finished_at = $n, result = $r WHERE day = $d").run({ n: core.now(), r: JSON.stringify(result), d: day });
  core.log.info("invest discovery", {
    day,
    added: result.added,
    skipped: result.skipped,
    moved: result.moved,
    removed: result.removed,
    sources: Object.entries(result.sources).map(([k, v]) => `${k} ${v.code}:${v.found}`).join(" · "),
  });
  return result;
}
