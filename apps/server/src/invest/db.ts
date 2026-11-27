/**
 * Invest tables (migration v8) through `db.sql` — kept out of db/index.ts so the invest code owns its SQL.
 */
import type { Db } from "../db/index.ts";

export interface InvestSettingsRow {
  user_id: string;
  mode: "mock" | "real";
  real_since: number | null;
  calls_json: string;
  thread_id: string | null;
  rev: number;
  toss_checked_at: number | null;
  toss_ok_at: number | null;
  toss_error: string | null;
  toss_error_at: number | null;
  toss_paused_until: number | null;
  blind_since: number | null;
  blind_banner_day: string | null;
  created_at: number;
  updated_at: number;
}

export interface WatchRow {
  user_id: string;
  symbol: string;
  market: "US" | "KR";
  name: string;
  added_at: number;
  /** v15: Toss's securityType asked with this person's token; '' = asked, Toss had none; null = not yet */
  security_type?: string | null;
  /** v15: Toss's Korean name from the same answer (the KR earnings subject, team-lead 1823); the screen keeps `name` */
  toss_name?: string | null;
  /** v15: the KST day the type was last asked (once a day per row, team-lead 1813 3) */
  type_asked_day?: string | null;
}

export interface RuleRow {
  id: string;
  user_id: string;
  symbol: string;
  kind: "stop" | "target" | "buy_zone" | "alert" | "resistance" | "invalidate";
  level: number | null;
  price: number | null;
  lo: number | null;
  hi: number | null;
  direction: "below" | "above" | "inside";
  action: "notify" | "call" | "sell";
  once: number;
  buffer_pct: number | null;
  conditions_json: string | null;
  until_day: string | null;
  state: "armed" | "hit" | "paused" | "expired";
  hit_at: number | null;
  hit_seq: number;
  cleared_at: number | null;
  paused_at: number | null;
  seen_slot: string | null;
  real_confirmed_at: number | null;
  rev: number;
  created_by: "person" | "proposal";
  created_at: number;
  updated_at: number;
}

export interface AlertRow {
  id: string;
  user_id: string;
  rule_id: string | null;
  symbol: string;
  kind: string;
  dedupe_key: string;
  price: number | null;
  observed_at: number;
  source: string;
  title: string;
  thread_id: string | null;
  message_id: string | null;
  call_state: string | null;
  called_at: number | null;
  created_at: number;
}

export interface OrderRow {
  id: string;
  user_id: string;
  rule_id: string;
  symbol: string;
  mode: "mock" | "real";
  client_order_id: string;
  toss_order_id: string | null;
  state: "recorded" | "submitted" | "filled" | "partial" | "failed" | "skipped";
  qty: number | null;
  filled_qty: number | null;
  avg_price: number | null;
  observed_price: number;
  stop_price: number;
  reason: string | null;
  message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface QuoteRow {
  user_id: string;
  symbol: string;
  price: number;
  prev_close: number | null;
  source: string;
  as_of: number;
  fetched_at: number;
}

// ───────────── settings ─────────────

export function getSettings(db: Db, userId: string): InvestSettingsRow | null {
  return db.sql.query("SELECT * FROM invest_settings WHERE user_id = $u").get({ u: userId }) as InvestSettingsRow | null;
}

export function ensureSettings(db: Db, userId: string, now: number): InvestSettingsRow {
  db.sql.query("INSERT OR IGNORE INTO invest_settings (user_id, created_at, updated_at) VALUES ($u, $n, $n)").run({ u: userId, n: now });
  return getSettings(db, userId)!;
}

type SettingsCols = Partial<Omit<InvestSettingsRow, "user_id" | "created_at">>;
export function updateSettings(db: Db, userId: string, cols: SettingsCols, now: number): void {
  const keys = Object.keys(cols).filter((k) => /^[a-z_]+$/.test(k));
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = $${k}`).join(", ");
  const params: Record<string, string | number | null> = { u: userId, now };
  for (const k of keys) params[k] = (cols as Record<string, string | number | null>)[k] ?? null;
  db.sql.query(`UPDATE invest_settings SET ${set}, updated_at = $now WHERE user_id = $u`).run(params);
}

/** every person with at least one watched symbol */
export function investUsers(db: Db): string[] {
  return (db.sql.query("SELECT DISTINCT user_id FROM invest_watchlist").all() as { user_id: string }[]).map((r) => r.user_id);
}

// ───────────── watchlist ─────────────

export function watchlist(db: Db, userId: string): WatchRow[] {
  return db.sql.query("SELECT * FROM invest_watchlist WHERE user_id = $u ORDER BY added_at DESC, symbol").all({ u: userId }) as WatchRow[];
}

export function watchRow(db: Db, userId: string, symbol: string): WatchRow | null {
  return db.sql.query("SELECT * FROM invest_watchlist WHERE user_id = $u AND symbol = $s").get({ u: userId, s: symbol }) as WatchRow | null;
}

export function addWatch(db: Db, w: WatchRow): boolean {
  return db.sql.query("INSERT OR IGNORE INTO invest_watchlist (user_id, symbol, market, name, added_at) VALUES ($u, $s, $m, $n, $a)").run({ u: w.user_id, s: w.symbol, m: w.market, n: w.name, a: w.added_at }).changes > 0;
}

/**
 * B2d-2c: Toss's answer for this person's own rows (asked with their token): each symbol asked gets its type and
 * Korean name, or '' when the answer has none (not asked again); the KST day either way.
 */
export function putWatchTypes(db: Db, userId: string, asked: string[], got: ReadonlyMap<string, { type: string; name: string | null }>, day: string): void {
  const q = db.sql.query("UPDATE invest_watchlist SET security_type = $t, toss_name = COALESCE($n, toss_name), type_asked_day = $d WHERE user_id = $u AND symbol = $s");
  for (const s of asked) {
    const a = got.get(s);
    q.run({ t: a ? a.type : "", n: a?.name ?? null, d: day, u: userId, s });
  }
}

/** B2d-2c: the type ask failed: the type stays unknown, asked again on another KST day */
export function markTypeAsked(db: Db, userId: string, asked: string[], day: string): void {
  const q = db.sql.query("UPDATE invest_watchlist SET type_asked_day = $d WHERE user_id = $u AND symbol = $s");
  for (const s of asked) q.run({ d: day, u: userId, s });
}

export function removeWatch(db: Db, userId: string, symbol: string): boolean {
  return db.sql.query("DELETE FROM invest_watchlist WHERE user_id = $u AND symbol = $s").run({ u: userId, s: symbol }).changes > 0;
}

// ───────────── rules ─────────────

export function rules(db: Db, userId: string, symbol?: string): RuleRow[] {
  if (symbol) return db.sql.query("SELECT * FROM invest_rules WHERE user_id = $u AND symbol = $s ORDER BY created_at, id").all({ u: userId, s: symbol }) as RuleRow[];
  return db.sql.query("SELECT * FROM invest_rules WHERE user_id = $u ORDER BY symbol, created_at, id").all({ u: userId }) as RuleRow[];
}

export function rule(db: Db, userId: string, id: string): RuleRow | null {
  return db.sql.query("SELECT * FROM invest_rules WHERE id = $id AND user_id = $u").get({ id, u: userId }) as RuleRow | null;
}

export function insertRule(db: Db, r: RuleRow): void {
  const cols = Object.keys(r);
  db.sql.query(`INSERT INTO invest_rules (${cols.join(", ")}) VALUES (${cols.map((c) => `$${c}`).join(", ")})`).run(r as unknown as Record<string, string | number | null>);
}

/** the person's definition columns; raises rev */
export function updateRuleDefinition(
  db: Db,
  r: Pick<RuleRow, "id" | "user_id" | "price" | "lo" | "hi" | "direction" | "action" | "once" | "buffer_pct" | "until_day" | "state" | "paused_at" | "seen_slot">,
  now: number,
): void {
  db.sql
    .query(
      `UPDATE invest_rules SET price = $price, lo = $lo, hi = $hi, direction = $direction, action = $action, once = $once, buffer_pct = $buffer_pct,
       until_day = $until_day, state = $state, paused_at = $paused_at, seen_slot = $seen_slot, rev = rev + 1, updated_at = $now WHERE id = $id AND user_id = $user_id`,
    )
    .run({ ...r, now } as unknown as Record<string, string | number | null>);
}

/** the watch's columns; never price, lo, hi, direction or action (G8: the watch does not move a rule), never rev */
export function updateRuleWatch(
  db: Db,
  id: string,
  rev: number,
  w: Pick<RuleRow, "state" | "hit_at" | "hit_seq" | "cleared_at" | "paused_at" | "seen_slot">,
  now: number,
): boolean {
  // only the rev the watch read: a save by the person in between wins (its seen_slot marker stays)
  return (
    db.sql
      .query(
        "UPDATE invest_rules SET state = $state, hit_at = $hit_at, hit_seq = $hit_seq, cleared_at = $cleared_at, paused_at = $paused_at, seen_slot = $seen_slot, updated_at = $now WHERE id = $id AND rev = $rev",
      )
      .run({ id, rev, state: w.state, hit_at: w.hit_at, hit_seq: w.hit_seq, cleared_at: w.cleared_at, paused_at: w.paused_at, seen_slot: w.seen_slot, now }).changes > 0
  );
}

export function deleteRule(db: Db, userId: string, id: string): boolean {
  return db.sql.query("DELETE FROM invest_rules WHERE id = $id AND user_id = $u").run({ id, u: userId }).changes > 0;
}

export function deleteSymbolRules(db: Db, userId: string, symbol: string): number {
  return db.sql.query("DELETE FROM invest_rules WHERE user_id = $u AND symbol = $s").run({ u: userId, s: symbol }).changes;
}

// ───────────── alerts / orders / calls ─────────────

/** false when the dedupe key was already used (another run sent it) */
export function insertAlert(db: Db, a: AlertRow): boolean {
  const cols = Object.keys(a);
  return (
    db.sql.query(`INSERT OR IGNORE INTO invest_alerts (${cols.join(", ")}) VALUES (${cols.map((c) => `$${c}`).join(", ")})`).run(a as unknown as Record<string, string | number | null>).changes > 0
  );
}

export function setAlertMessage(db: Db, id: string, threadId: string, messageId: string): void {
  db.sql.query("UPDATE invest_alerts SET thread_id = $t, message_id = $m WHERE id = $id").run({ id, t: threadId, m: messageId });
}

export function setAlertCall(db: Db, id: string, state: string, at: number): void {
  db.sql.query("UPDATE invest_alerts SET call_state = $s, called_at = $a WHERE id = $id").run({ id, s: state, a: at });
}

export function recentAlerts(db: Db, userId: string, symbol: string, limit = 5): AlertRow[] {
  return db.sql.query("SELECT * FROM invest_alerts WHERE user_id = $u AND symbol = $s ORDER BY created_at DESC, rowid DESC LIMIT $l").all({ u: userId, s: symbol, l: limit }) as AlertRow[];
}

export function insertOrder(db: Db, o: OrderRow): boolean {
  const cols = Object.keys(o);
  return db.sql.query(`INSERT OR IGNORE INTO invest_orders (${cols.join(", ")}) VALUES (${cols.map((c) => `$${c}`).join(", ")})`).run(o as unknown as Record<string, string | number | null>).changes > 0;
}

export function setOrderMessage(db: Db, id: string, messageId: string, now: number): void {
  db.sql.query("UPDATE invest_orders SET message_id = $m, updated_at = $n WHERE id = $id").run({ id, m: messageId, n: now });
}

export function openOrders(db: Db, userId: string): number {
  return (db.sql.query("SELECT COUNT(*) AS n FROM invest_orders WHERE user_id = $u AND mode = 'real' AND state IN ('submitted', 'partial')").get({ u: userId }) as { n: number }).n;
}

export function callsSince(db: Db, userId: string, since: number): number {
  return (db.sql.query("SELECT COUNT(*) AS n FROM invest_calls WHERE user_id = $u AND at >= $s").get({ u: userId, s: since }) as { n: number }).n;
}

export function insertCall(db: Db, c: { id: string; user_id: string; ref: string; state: string; at: number }): void {
  db.sql.query("INSERT INTO invest_calls (id, user_id, ref, state, at) VALUES ($id, $user_id, $ref, $state, $at)").run(c);
}

// ───────────── quotes ─────────────

export function quotes(db: Db, userId: string): QuoteRow[] {
  return db.sql.query("SELECT * FROM invest_quotes WHERE user_id = $u").all({ u: userId }) as QuoteRow[];
}

export function putQuote(db: Db, q: QuoteRow): void {
  db.sql
    .query(
      `INSERT INTO invest_quotes (user_id, symbol, price, prev_close, source, as_of, fetched_at) VALUES ($user_id, $symbol, $price, $prev_close, $source, $as_of, $fetched_at)
       ON CONFLICT (user_id, symbol) DO UPDATE SET price = excluded.price, prev_close = excluded.prev_close, source = excluded.source, as_of = excluded.as_of, fetched_at = excluded.fetched_at`,
    )
    .run(q as unknown as Record<string, string | number | null>);
}

export function deleteQuote(db: Db, userId: string, symbol: string): void {
  db.sql.query("DELETE FROM invest_quotes WHERE user_id = $u AND symbol = $s").run({ u: userId, s: symbol });
}

// the ledger's one write path is ledger.ts (B2a)

// ───────────── shared cache / source state / previews ─────────────

export function cacheGet(db: Db, key: string, now: number): string | null {
  const r = db.sql.query("SELECT body FROM invest_cache WHERE key = $k AND expires_at > $n").get({ k: key, n: now }) as { body: string } | null;
  return r?.body ?? null;
}

export function cachePut(db: Db, key: string, body: string, now: number, expiresAt: number): void {
  db.sql.query("INSERT OR REPLACE INTO invest_cache (key, body, fetched_at, expires_at) VALUES ($k, $b, $n, $e)").run({ k: key, b: body, n: now, e: expiresAt });
}

export function sourcePausedUntil(db: Db, source: string): number | null {
  const r = db.sql.query("SELECT paused_until FROM invest_source_state WHERE source = $s").get({ s: source }) as { paused_until: number | null } | null;
  return r?.paused_until ?? null;
}

export function sourceRecord(db: Db, source: string, r: { status: number; error: string | null; pausedUntil: number | null; now: number }): void {
  db.sql
    .query(
      `INSERT INTO invest_source_state (source, paused_until, last_status, last_error, updated_at) VALUES ($s, $p, $st, $e, $n)
       ON CONFLICT (source) DO UPDATE SET paused_until = CASE WHEN excluded.paused_until IS NOT NULL THEN excluded.paused_until ELSE invest_source_state.paused_until END,
       last_status = excluded.last_status, last_error = excluded.last_error, updated_at = excluded.updated_at`,
    )
    .run({ s: source, p: r.pausedUntil, st: r.status, e: r.error, n: r.now });
}

export function putPreview(db: Db, p: { id: string; user_id: string; kind: string; spec_json: string; expires_at: number }): void {
  db.sql.query("INSERT INTO invest_previews (id, user_id, kind, spec_json, expires_at) VALUES ($id, $user_id, $kind, $spec_json, $expires_at)").run(p);
  db.sql.query("DELETE FROM invest_previews WHERE expires_at < $n").run({ n: p.expires_at - 3_600_000 });
}

export function getPreview(db: Db, userId: string, id: string, now: number): { kind: string; spec_json: string } | null {
  return db.sql.query("SELECT kind, spec_json FROM invest_previews WHERE id = $id AND user_id = $u AND expires_at > $n AND used_at IS NULL").get({ id, u: userId, n: now }) as {
    kind: string;
    spec_json: string;
  } | null;
}

export function usePreview(db: Db, id: string, now: number): void {
  db.sql.query("UPDATE invest_previews SET used_at = $n WHERE id = $id").run({ id, n: now });
}
