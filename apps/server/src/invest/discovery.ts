/**
 * New events found (B2d-2a; team-lead 0052 B2d, 1550, 1618; DD 1551): once a day from 07:00 KST the server reads three
 * public T1 calendars and puts what is coming in the calendar of each person who uses invest, as author `code`.
 *
 * - Sources: the Federal Register's rules (one fixed query: the Industry and Security Bureau and USTR, significant rules
 *   with an effective date, the words semiconductor, export control, Section 232, Section 301), the Fed's FOMC meetings
 *   (the decision day, 14:00 ET) and BLS's release calendar (CPI, the Employment Situation, PPI; 08:30 ET).
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
 *   MAX_EVENTS. An item names one occurrence (team-lead 1712, DD 1711): `fr:<document number>`, `fomc:<first day>`,
 *   `cpi:2026-11` (the reference month) or `ppi:2026-12-11` (the release day when no month is written).
 * - Nothing announces a find (DD 1551 6): the calendar, the 08:00 report's events and D-1 show it, as any code event.
 */
import type { InvestEventKind } from "@pickle/protocol";
import { dayNumber } from "@pickle/quant";
import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import { errInfo } from "../log.ts";
import { etDate, kstDay, marketClock, marketDate, type Market } from "./calendar.ts";
import { createEvent, EVENT_MAX_DAYS, EVENT_SPAN_DAYS } from "./events.ts";
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

// ───────────────────────────── BLS release calendar (ICS) ─────────────────────────────

const BLS_ITEMS: readonly { re: RegExp; item: string; words: string }[] = [
  { re: /^consumer price index\b/i, item: "cpi", words: "CPI" },
  { re: /^(the )?employment situation\b/i, item: "nfp", words: "고용보고서" },
  { re: /^producer price index\b/i, item: "ppi", words: "PPI" },
];
const REF_MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/;

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
  // a wall time: BLS writes US Eastern (TZID=US-Eastern / America/New_York); another zone is not read
  if (!/TZID=(US-Eastern|America\/New_York)/i.test(params)) return null;
  return { day, time: `${m[4]}:${m[5]}` };
}

/** CPI, the Employment Situation and PPI from the calendar; the title names the reference month only when the event writes it */
export function parseBlsIcs(body: string): Found[] | null {
  if (!/BEGIN:VCALENDAR/.test(body)) return null;
  const lines = body.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: Found[] = [];
  let ev: Record<string, { params: string; value: string }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT" && ev) {
      const summary = icsText(ev.SUMMARY?.value ?? "");
      const desc = icsText(ev.DESCRIPTION?.value ?? "");
      const hit = BLS_ITEMS.find((b) => b.re.test(summary));
      const start = ev.DTSTART ? icsStart(ev.DTSTART.params, ev.DTSTART.value) : null;
      if (hit && start) {
        const ref = REF_MONTH.exec(summary) ?? REF_MONTH.exec(desc);
        const month = ref ? monthOf(ref[1]!) : null;
        // the reference month names the release; without one, its day (team-lead 1712)
        const item = month ? `${hit.item}:${ref![2]}-${pad(month)}` : `${hit.item}:${start.day}`;
        out.push({ source: "bls", item, market: "US", day: start.day, time: start.time, kind: "macro", title: month ? `미국 ${month}월 ${hit.words} 발표` : `미국 ${hit.words} 발표`, url: "https://www.bls.gov/schedule/news_release/" });
      }
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

// ───────────────────────────── the day's run ─────────────────────────────

const SOURCES: readonly { source: DiscoverySource; url: (now: number) => string; parse: (body: string) => Found[] | null; ahead: number }[] = [
  { source: "fedreg", url: (now) => FEDREG_URL(etDate(now)), parse: parseFedRegister, ahead: EVENT_MAX_DAYS },
  { source: "fomc", url: () => FOMC_URL, parse: parseFomc, ahead: EVENT_SPAN_DAYS },
  { source: "bls", url: () => BLS_URL, parse: parseBlsIcs, ahead: EVENT_SPAN_DAYS },
];

export interface DiscoveryResult {
  day: string;
  sources: Partial<Record<DiscoverySource, { code: string; found: number; text?: "확인 불가" }>>;
  added: number;
  skipped: number;
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

/** from 07:00 KST, once per KST day: the three sources, then each invest user's calendar. null when not due or taken */
export async function discoverDay(core: Core, gate: SourceGate, now: number): Promise<DiscoveryResult | null> {
  if (!core.cfg.invest.sources) return null;
  if (marketClock("KR", now) < DISCOVERY_AT_KST) return null;
  const day = kstDay(now);
  const taken = core.db.sql.query("INSERT OR IGNORE INTO invest_discovery (day, state, started_at) VALUES ($d, 'running', $n)").run({ d: day, n: now }).changes === 1;
  if (!taken) return null;
  const result: DiscoveryResult = { day, sources: {}, added: 0, skipped: 0 };
  const found: Found[] = [];
  for (const s of SOURCES) {
    const r = await gate.get(s.source, s.url(now));
    if (!r.ok) {
      result.sources[s.source] = { code: r.code, found: 0, text: "확인 불가" };
      continue;
    }
    const items = s.parse(r.text);
    if (!items) {
      gate.pauseForJunk(s.source);
      result.sources[s.source] = { code: "not_data", found: 0, text: "확인 불가" };
      continue;
    }
    const kept = items.filter((f) => inWindow(f, now, s.ahead));
    result.sources[s.source] = { code: "ok", found: kept.length };
    found.push(...kept);
  }
  const users = (core.db.sql.query("SELECT user_id FROM invest_settings ORDER BY user_id").all() as { user_id: string }[]).map((r) => r.user_id);
  for (const userId of users) {
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
        // the same day and title already there, or the person's upcoming events at their cap: left as they are
        if (!(err instanceof HttpError)) core.log.error("invest discovery add failed", { err: errInfo(err) });
        result.skipped++;
      }
    }
  }
  core.db.sql.query("UPDATE invest_discovery SET state = 'done', finished_at = $n, result = $r WHERE day = $d").run({ n: core.now(), r: JSON.stringify(result), d: day });
  core.log.info("invest discovery", { day, added: result.added, skipped: result.skipped, sources: Object.entries(result.sources).map(([k, v]) => `${k} ${v.code}:${v.found}`).join(" · ") });
  return result;
}
