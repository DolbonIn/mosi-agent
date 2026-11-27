/**
 * The event calendar and its D-1 reminder (team-lead 0052 B2a and 0056; DD 0109 §1).
 *
 * - An event is a person's own: market, the market's date, its wall-clock time when known, kind, title, symbol, and
 *   where it came from (source, tier, grade, link). One per person, market, day and title.
 * - D-1 goes at 08:00 KST on the day before the event's market date, whatever the market does that day (a holiday's
 *   eve too). The day is the event's own date: a US event on Tuesday ET reminds on Monday 08:00 KST.
 * - It goes once per person, event (market and title) and day, by any path: the reminder row is claimed before the
 *   card is stored, in one transaction. Deleting the event keeps that row, so adding it back sends nothing again. For
 *   a person whose 08:00 report goes out today the report (B2c-1) claims the same row and carries the line instead.
 * - Several due for one person at once: one card, a row each, titled "일정 N개"; the in-app banner is its title alone.
 */
import type { InvestAuthor, InvestEvent, InvestEventCard, InvestEventKind, InvestGrade, InvestMarket, InvestTier } from "@pickle/protocol";
import { civilDate, dayNumber, kst, kstWithEastern } from "@pickle/quant";
import type { Db } from "../db/index.ts";
import { bad, HttpError } from "../http.ts";
import { newId } from "../util.ts";
import { etToEpoch, kstDay, kstToEpochDay, marketDate, marketOf, normalizeSymbol } from "./calendar.ts";
import { invalidOf, isDay, lineOf, oneOf, sourceOf } from "./ledger.ts";
import { eunNeun, ieyo } from "./rules.ts";

export const MAX_EVENTS = 200;
/** a day up to two years ahead */
export const EVENT_MAX_DAYS = 2 * 366;
/** GET /api/invest/events: 60 days from yesterday (KST) by default, 400 at most */
export const EVENT_SPAN_DAYS = 60;
export const EVENT_SPAN_MAX_DAYS = 400;
/** team-lead 0056: D-1 at 08:00 KST */
export const REMIND_HOUR_KST = 8;
export const EVENT_KINDS = ["earnings", "macro", "policy", "contract", "other"] as const satisfies readonly InvestEventKind[];

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface EventRow {
  id: string;
  user_id: string;
  market: string;
  day: string;
  time: string | null;
  kind: string;
  title: string;
  symbol: string | null;
  source: string;
  source_tier: string;
  confidence: string;
  url: string | null;
  author: string;
  remind: number;
  created_at: number;
  updated_at: number;
  /** a found event's source and item (discovery.ts, v14); null for the person's and the model's */
  disc_source: string | null;
  disc_item: string | null;
}

const invalid = invalidOf("invalid_event");
const md = (day: string) => `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;
const shift = (day: string, days: number) => civilDate(dayNumber(day) + days);

// ───────────── words (the server's; DD 0109 §1) ─────────────

/**
 * the title as cards show it: the symbol first when there is one and the title does not start with it; a found
 * earnings row already starts with its subject (US the symbol, KR the name: DD 1754), so nothing goes in front
 */
export function eventHeading(r: Pick<EventRow, "title" | "symbol"> & Partial<Pick<EventRow, "disc_source">>): string {
  if (r.disc_source === "company") return r.title;
  return r.symbol && r.title !== r.symbol && !r.title.startsWith(`${r.symbol} `) ? `${r.symbol} ${r.title}` : r.title;
}

/** the instant of a timed event, or null */
export function eventAt(r: Pick<EventRow, "market" | "day" | "time">): number | null {
  if (!r.time) return null;
  const [h, m] = r.time.split(":").map(Number) as [number, number];
  return r.market === "US" ? etToEpoch(r.day, h, m) : kstToEpochDay(r.day, h, m);
}

/**
 * KST first, the US market's time in brackets: 11월 26일 06:20(미 동부 16:20) · 11월 26일 10:00; no time: the market's
 * date. Another year than this KST one names it (DD 0405 E): 2027년 1월 5일 06:20(미 동부 16:20) · 미 동부 2027년 1월 5일 ·
 * 시각 미정 — the KST date's year for a timed event, the market date's without a time.
 */
export function eventWhen(r: Pick<EventRow, "market" | "day" | "time">, now: number): string {
  const thisYear = kstDay(now).slice(0, 4);
  const at = eventAt(r);
  if (at != null) {
    const y = kstDay(at).slice(0, 4);
    const s = r.market === "US" ? kstWithEastern(at) : kst(at);
    return y === thisYear ? s : `${Number(y)}년 ${s}`;
  }
  const d = r.day.slice(0, 4) === thisYear ? md(r.day) : `${Number(r.day.slice(0, 4))}년 ${md(r.day)}`;
  return r.market === "US" ? `미 동부 ${d} · 시각 미정` : `${d} · 시각 미정`;
}

export const eventFoot = (r: Pick<EventRow, "source" | "confidence">) => `${r.source} · ${r.confidence}`;

// ───────────── make, switch, delete, read ─────────────

function checkEvent(body: unknown, now: number) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("일정이 올바르지 않아요.");
  const b = body as Record<string, unknown>;
  const market = oneOf(b.market, ["US", "KR"] as const, "시장", invalid);
  if (!isDay(b.day)) throw invalid("날짜는 YYYY-MM-DD로 넣어 주세요.");
  const today = marketDate(market, now);
  if (b.day < today) throw invalid(`${eunNeun(b.day)} 지난 날이에요. ${market === "US" ? `오늘은 ${today}(미 동부)예요.` : `오늘은 ${ieyo(today)}.`}`); // DD 0521 §2
  if (dayNumber(b.day) - dayNumber(today) > EVENT_MAX_DAYS) throw invalid("일정은 2년 안으로 넣어 주세요.");
  let time: string | null = null;
  if (b.time !== undefined && b.time !== null && b.time !== "") {
    if (typeof b.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) throw invalid("시각은 그 시장 시각 HH:MM으로 넣어 주세요.");
    time = b.time;
  }
  const kind = oneOf(b.kind, EVENT_KINDS, "종류", invalid);
  const title = lineOf(b.title, "제목", 80, invalid)!;
  let symbol: string | null = null;
  if (b.symbol !== undefined && b.symbol !== null && b.symbol !== "") {
    symbol = normalizeSymbol(b.symbol);
    if (!symbol) throw invalid("종목 기호가 올바르지 않아요.");
    if (marketOf(symbol) !== market) throw invalid("종목과 시장이 맞지 않아요.");
  }
  if (b.remind !== undefined && typeof b.remind !== "boolean") throw invalid("D-1 알림은 켜기와 끄기로 정해 주세요.");
  return { market, day: b.day, time, kind, title, symbol, ...sourceOf(b, invalid), remind: b.remind !== false };
}

export function createEvent(db: Db, userId: string, body: unknown, author: InvestAuthor, now: number, disc?: { source: string; item: string }): InvestEvent {
  const e = checkEvent(body, now);
  return db.tx(() => {
    const same = db.sql.query("SELECT * FROM invest_events WHERE user_id = $u AND market = $m AND day = $d AND title = $t").get({ u: userId, m: e.market, d: e.day, t: e.title }) as EventRow | null;
    if (same) throw new HttpError(409, "event_exists", "같은 날 같은 제목의 일정이 있어요.", undefined, { event: eventView(db, same, now) });
    const n = (db.sql.query("SELECT COUNT(*) AS n FROM invest_events WHERE user_id = $u AND day >= $d").get({ u: userId, d: shift(kstDay(now), -1) }) as { n: number }).n;
    if (n >= MAX_EVENTS) throw bad(`다가오는 일정은 ${MAX_EVENTS}개까지 둘 수 있어요.`, "too_many_events");
    const row: EventRow = {
      id: newId("ie"),
      user_id: userId,
      market: e.market,
      day: e.day,
      time: e.time,
      kind: e.kind,
      title: e.title,
      symbol: e.symbol,
      source: e.source,
      source_tier: e.sourceTier,
      confidence: e.confidence,
      url: e.url,
      author,
      remind: e.remind ? 1 : 0,
      created_at: now,
      updated_at: now,
      disc_source: disc?.source ?? null,
      disc_item: disc?.item ?? null,
    };
    const cols = Object.keys(row);
    db.sql.query(`INSERT INTO invest_events (${cols.join(", ")}) VALUES (${cols.map((c) => `$${c}`).join(", ")})`).run(row as unknown as Record<string, string | number | null>);
    return eventView(db, row, now);
  });
}

export function eventRow(db: Db, userId: string, id: string | undefined): EventRow {
  const r = id ? (db.sql.query("SELECT * FROM invest_events WHERE id = $id AND user_id = $u").get({ id, u: userId }) as EventRow | null) : null;
  if (!r) throw new HttpError(404, "event_not_found", "이미 지워진 일정이에요.");
  return r;
}

/** PATCH { remind }: the only thing that changes on an event (DD 0109 §1: D-1 is switched off here, not on the card) */
export function setEventRemind(db: Db, userId: string, id: string | undefined, body: unknown, now: number): InvestEvent {
  const r = eventRow(db, userId, id);
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.remind !== "boolean") throw invalid("D-1 알림은 켜기와 끄기로 정해 주세요.");
  db.sql.query("UPDATE invest_events SET remind = $r, updated_at = $n WHERE id = $id AND user_id = $u").run({ r: b.remind ? 1 : 0, n: now, id: r.id, u: userId });
  return eventView(db, { ...r, remind: b.remind ? 1 : 0, updated_at: now }, now);
}

/** a found event deleted is marked for that person (team-lead 1550 5, 1618), so discovery does not put it back */
export function deleteEvent(db: Db, userId: string, id: string | undefined, now = Date.now()): void {
  const r = eventRow(db, userId, id);
  db.tx(() => {
    db.sql.query("DELETE FROM invest_events WHERE id = $id AND user_id = $u").run({ id: r.id, u: userId });
    if (r.disc_source && r.disc_item)
      db.sql
        .query("INSERT OR IGNORE INTO invest_event_dismissed (user_id, source, item, day, symbol, dismissed_at) VALUES ($u, $s, $i, $d, $y, $n)")
        .run({ u: userId, s: r.disc_source, i: r.disc_item, d: r.day, y: r.symbol ?? "", n: now });
  });
}

export function listEvents(db: Db, userId: string, q: { from?: string | null; to?: string | null }, now: number): InvestEvent[] {
  if (q.from && !isDay(q.from)) throw invalid("from은 YYYY-MM-DD로 넣어 주세요.");
  if (q.to && !isDay(q.to)) throw invalid("to는 YYYY-MM-DD로 넣어 주세요.");
  const from = q.from || shift(kstDay(now), -1);
  const to = q.to || shift(from, EVENT_SPAN_DAYS);
  if (to < from) throw invalid("to가 from보다 앞이에요.");
  if (dayNumber(to) - dayNumber(from) > EVENT_SPAN_MAX_DAYS) throw invalid(`한 번에 ${EVENT_SPAN_MAX_DAYS}일까지 볼 수 있어요.`);
  const rows = db.sql.query("SELECT * FROM invest_events WHERE user_id = $u AND day BETWEEN $f AND $t").all({ u: userId, f: from, t: to }) as EventRow[];
  return sortEvents(rows).map((r) => eventView(db, r, now));
}

/** by day, then timed events by instant, untimed last (by market, then title) */
export function sortEvents(rows: EventRow[]): EventRow[] {
  return rows.sort((a, b) => a.day.localeCompare(b.day) || (eventAt(a) ?? Infinity) - (eventAt(b) ?? Infinity) || a.market.localeCompare(b.market) || a.title.localeCompare(b.title));
}

function reminded(db: Db, r: EventRow): boolean {
  return !!db.sql.query("SELECT 1 FROM invest_event_reminders WHERE user_id = $u AND market = $m AND day = $d AND title = $t").get({ u: r.user_id, m: r.market, d: r.day, t: r.title });
}

export function eventView(db: Db, r: EventRow, now: number): InvestEvent {
  return {
    id: r.id,
    market: r.market as InvestMarket,
    day: r.day,
    time: r.time,
    kind: r.kind as InvestEventKind,
    title: r.title,
    symbol: r.symbol,
    heading: eventHeading(r),
    when: eventWhen(r, now),
    source: r.source,
    sourceTier: r.source_tier as InvestTier,
    url: r.url,
    confidence: r.confidence as InvestGrade,
    foot: eventFoot(r),
    remind: r.remind === 1,
    remindOn: shift(r.day, -1),
    reminded: reminded(db, r),
    author: r.author as InvestAuthor,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ───────────── D-1 ─────────────

/**
 * from 08:00 KST: each person's events dated tomorrow (KST), switched on, whose D-1 has not gone — added before 08:00
 * today, or by code (DD 0405 F: one the person or the model added after 08:00 was just said in that very turn or
 * screen; one a code source found later the person does not know yet)
 */
export function dueReminders(db: Db, now: number): Map<string, EventRow[]> {
  const out = new Map<string, EventRow[]>();
  const sinceMidnight = (((now + 9 * HOUR) % DAY) + DAY) % DAY;
  if (Math.floor(sinceMidnight / HOUR) < REMIND_HOUR_KST) return out;
  const cut = now - sinceMidnight + REMIND_HOUR_KST * HOUR;
  const rows = db.sql
    .query(
      `SELECT e.* FROM invest_events e WHERE e.day = $t AND e.remind = 1 AND (e.author = 'code' OR e.created_at < $cut)
       AND NOT EXISTS (SELECT 1 FROM invest_event_reminders r WHERE r.user_id = e.user_id AND r.market = e.market AND r.day = e.day AND r.title = e.title)`,
    )
    .all({ t: shift(kstDay(now), 1), cut }) as EventRow[];
  for (const r of sortEvents(rows)) {
    const list = out.get(r.user_id);
    if (list) list.push(r);
    else out.set(r.user_id, [r]);
  }
  return out;
}

/** take the event's one D-1 (false: it already went by some path) */
export function claimReminder(db: Db, r: EventRow, via: "card" | "daily", now: number): boolean {
  return (
    db.sql
      .query("INSERT OR IGNORE INTO invest_event_reminders (user_id, market, day, title, event_id, via, message_id, sent_at) VALUES ($u, $m, $d, $t, $id, $via, NULL, $n)")
      .run({ u: r.user_id, m: r.market, d: r.day, t: r.title, id: r.id, via, n: now }).changes === 1
  );
}

export function noteReminderMessage(db: Db, rows: readonly EventRow[], messageId: string): void {
  for (const r of rows)
    db.sql.query("UPDATE invest_event_reminders SET message_id = $mid WHERE user_id = $u AND market = $m AND day = $d AND title = $t").run({ mid: messageId, u: r.user_id, m: r.market, d: r.day, t: r.title });
}

export function eventCard(rows: readonly EventRow[], now: number): InvestEventCard {
  const items = rows.map((r) => ({ eventId: r.id, title: eventHeading(r), when: eventWhen(r, now), foot: eventFoot(r) }));
  return { type: "invest_event", title: items.length === 1 ? items[0]!.title : `일정 ${items.length}개`, rows: items, disclaimer: true };
}

/** the thread's record of the card (what the model reads back later) */
export function eventRecord(card: InvestEventCard): string {
  return `[투자 일정] ${card.rows.map((r) => `${r.title} · ${r.when} · ${r.foot}`).join(" / ")}`;
}
