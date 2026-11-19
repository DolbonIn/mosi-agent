/**
 * k-skill connections, server side (docs/architecture/KSKILL-CONNECTIONS.md "Server side"): the services a person
 * connects with their own account (팝빌, 토스증권 …) sit next to the messenger connections in /api/connections.
 *
 *  - The device seals the fields into the vault (aad `${userId}:${service}:${kind}`), exactly like a messenger login.
 *    The server opens them only inside ConnectionRegistry: `verify` right after the save, `revoke` on disconnect, and
 *    a tool's run (ToolContext.connections). Nothing here reads, logs or returns a secret.
 *  - Connecting: save → verify → wake the turns waiting for this service (notifyConnected, which also drops older rows)
 *    → flip the stored pending `connection_request` cards to "connected". Exactly one card offers 이어서 하기, and only
 *    when no turn picks the connect up by itself: the newest stored card, or the card of the turn still running
 *    (settled when that turn is stored).
 *  - A refused login (401/403, wrong key) that this request saved is removed again. When the upstream could not answer
 *    (`retryable`: timeout, 5xx, network) the row stays, the answer is "needs_verification", and the server checks again
 *    after `cfg.connectionRecheckMs` (30 s, 2 min, 10 min; never sooner than `cfg.connectionRecheckFloorMs` for a
 *    service whose check spends the user's quota, e.g. 쿠팡 파트너스 once an hour): connected, removed, or — still
 *    unreachable — kept, unconfirmed.
 *  - `{credentialId}` re-checks a saved login. Only an unconfirmed one becomes a connect when it passes; a login that
 *    already worked is no new connect (a tool that just refused it keeps its card pending), and is never removed.
 *  - Disconnecting: upstream sign-out where the service has one, then every row and cached session goes.
 */
import { ConnectionRegistry } from "@pickle/agent";
import type { Card, Connection, ConnectResponse, CredentialInfo, ProviderInfo } from "@pickle/protocol";
import { publishMessage, publishThread, type Core } from "./core.ts";
import type { AppDeps, ConnectionsLike, Timers } from "./deps.ts";
import { errInfo } from "./log.ts";
import { safeJson } from "./util.ts";

/** createApp's registry when the caller passes none (tests): the vault plus the skills catalog. main.ts passes its own. */
export function defaultConnections(deps: AppDeps, now: () => number): ConnectionsLike {
  return new ConnectionRegistry({ vault: deps.vault, services: () => deps.skills.connectionServices?.() ?? [], now });
}

/** ids are vault service ids (no dots); a dotted id can never be a catalog service */
export function isKskillService(core: Core, id: string): boolean {
  try {
    return core.connections.isService(id);
  } catch {
    return false;
  }
}

/** a steady hue per service, so the list doesn't reshuffle colours between releases */
function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/**
 * The catalog as ProviderInfo rows (category "korea"): the connect sheet asks for `fields` and seals them on the device
 * as `kind` (aad `${userId}:${id}:${kind}`). API-key services are auth "api_key" / kind "token"; an id + password
 * service is auth "credentials" / kind "login". Empty `optional` fields are left out of the sealed secret.
 */
export function kskillProviders(core: Core): ProviderInfo[] {
  let list: ReturnType<ConnectionsLike["catalog"]> = [];
  try {
    list = core.connections.catalog();
  } catch (err) {
    core.log.warn("connection catalog unavailable", { err: errInfo(err) });
  }
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    category: "korea" as const,
    icon: s.kind === "token" ? ("key" as const) : ("lock" as const),
    hue: hueOf(s.id),
    auth: s.kind === "token" ? ("api_key" as const) : ("credentials" as const),
    fields: s.fields.map((f) => ({ ...f })),
    kind: s.kind,
    ...(s.kind === "login" ? { login: "password" as const } : {}),
    description: s.description,
    capabilities: [],
    available: true,
  }));
}

/**
 * k-skill services as Connection rows: "connected" for a live login; "error" (the app's 다시 연결) when the only saved
 * login ran past its keep-for; no row when nothing was ever saved, as for messengers.
 */
export async function kskillConnectionRows(core: Core, userId: string): Promise<Connection[]> {
  try {
    const rows = await core.connections.status(userId);
    const expired = rows.some((r) => !r.connected) ? (await core.deps.vault.list(userId)).filter((r) => r.expired) : [];
    const out: Connection[] = [];
    for (const r of rows) {
      if (r.connected) {
        // a login no check has passed yet: "needs_verification" (being re-checked, or the re-checks gave up)
        const ck = r.credentialId ? keyOf(userId, r.credentialId) : "";
        const unconfirmed = !!ck && stateOf(core).unconfirmed.has(ck);
        out.push({
          provider: r.service,
          status: unconfirmed ? "needs_verification" : "connected",
          accountLabel: r.hint || null,
          credentialId: r.credentialId,
          lastError: unconfirmed ? (stateOf(core).recheck.has(ck) ? recheckCopy(r.serviceName) : unconfirmedCopy(r.serviceName)) : null,
          connectedAt: r.connectedAt,
          updatedAt: r.lastUsedAt ?? r.connectedAt ?? core.now(),
        });
        continue;
      }
      const old = expired.filter((x) => x.service === r.service).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!old) continue;
      out.push({
        provider: r.service,
        status: "error",
        accountLabel: old.hint || null,
        credentialId: old.id,
        lastError: "보관 기간이 끝났어요. 다시 연결해 주세요.",
        connectedAt: old.createdAt,
        updatedAt: old.expiresAt ?? old.createdAt,
      });
    }
    return out;
  } catch (err) {
    core.log.warn("connection status failed", { err: errInfo(err) });
    return [];
  }
}

/** Names of the connected k-skill services, for the system prompt's "연결된 서비스" line. */
export async function kskillConnectedNames(core: Core, userId: string): Promise<string[]> {
  try {
    return (await core.connections.status(userId)).filter((r) => r.connected).map((r) => r.serviceName);
  } catch {
    return [];
  }
}

// ───────────── which connects happened after a card was raised (in memory, per process) ─────────────

/**
 * per user+service: `epoch` counts verified connects; `live` counts running turns holding a pending card.
 * per user+credential: `unconfirmed` = saved logins whose verify could not reach the upstream (not yet a connect);
 * `recheck` = those of them with a background check scheduled (listed as "needs_verification").
 */
interface KskillState {
  epoch: Map<string, number>;
  live: Map<string, number>;
  unconfirmed: Set<string>;
  recheck: Map<string, { timer: unknown }>;
  stopped: boolean;
}
const STATE = new WeakMap<Core, KskillState>();
function stateOf(core: Core): KskillState {
  let st = STATE.get(core);
  if (!st) STATE.set(core, (st = { epoch: new Map(), live: new Map(), unconfirmed: new Set(), recheck: new Map(), stopped: false }));
  return st;
}

/** a saved login is no longer unconfirmed (connected, refused or gone): its scheduled check, if any, is dropped */
function settleUnconfirmed(core: Core, userId: string, credentialId: string): void {
  const st = stateOf(core);
  const k = keyOf(userId, credentialId);
  st.unconfirmed.delete(k);
  const e = st.recheck.get(k);
  if (e?.timer != null) timersOf(core).clear(e.timer);
  st.recheck.delete(k);
}

/** the background re-check delays for `service`: cfg.connectionRecheckMs, none sooner than its quota floor */
export function recheckDelays(core: Core, service: string): number[] {
  const floor = core.cfg.connectionRecheckFloorMs[service] ?? 0;
  return core.cfg.connectionRecheckMs.map((d) => Math.max(d, floor));
}

const REAL_TIMERS: Timers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.(); // a pending re-check never keeps the process alive
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const timersOf = (core: Core): Timers => core.deps.timers ?? REAL_TIMERS;

/** app.close(): no further re-checks (one already running finishes; core.idle() awaits it) */
export function stopKskill(core: Core): void {
  const st = stateOf(core);
  st.stopped = true;
  for (const e of st.recheck.values()) if (e.timer != null) timersOf(core).clear(e.timer);
  st.recheck.clear();
}

const recheckCopy = (serviceName: string) => `지금은 ${serviceName}에 확인하지 못했어요. 저장해 두었고 잠시 후 다시 확인할게요.`;
const unconfirmedCopy = (serviceName: string) => `아직 ${serviceName}에 확인하지 못했어요. 키를 다시 입력하면 바로 다시 확인할게요.`;
const keyOf = (userId: string, service: string) => `${userId}\u0000${service}`;
const epochOf = (core: Core, userId: string, service: string) => stateOf(core).epoch.get(keyOf(userId, service)) ?? 0;
const continueAction = (serviceName: string) => ({ label: "이어서 하기", send: `${serviceName} 연결했어요. 이어서 해 주세요.` });

export interface TurnConnectionCards {
  /** every card the turn streams (pending `connection_request` cards are noted with the connect count of that moment) */
  onCard(card: Card): void;
  /**
   * At persist time (no await between this and the insert): a pending card whose service got a verified connect after
   * the card was raised is stored "connected" with 이어서 하기 — the turn's wait was over (or it had none). A login the
   * upstream refused, or one still being verified, is no connect: that card stays pending. Ends the tracking.
   */
  settle(cards: Card[]): Card[];
  /** ends the tracking (idempotent; also called from the turn's finally) */
  done(): void;
}

export function trackConnectionCards(core: Core, userId: string): TurnConnectionCards {
  const st = stateOf(core);
  const prefix = keyOf(userId, "");
  const start = new Map<string, number>();
  for (const [k, v] of st.epoch) if (k.startsWith(prefix)) start.set(k.slice(prefix.length), v);
  const raised = new Map<string, number>();
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    for (const service of raised.keys()) {
      const k = keyOf(userId, service);
      const n = (st.live.get(k) ?? 1) - 1;
      if (n > 0) st.live.set(k, n);
      else st.live.delete(k);
    }
  };
  return {
    onCard(card) {
      if (closed || card.type !== "connection_request" || card.status !== "pending") return;
      const first = !raised.has(card.service);
      // every pending card counts from its own moment: a second card (the retried call refused the new login) needs
      // a connect after it, not after the first card
      raised.set(card.service, epochOf(core, userId, card.service));
      if (!first) return;
      const k = keyOf(userId, card.service);
      st.live.set(k, (st.live.get(k) ?? 0) + 1);
    },
    settle(cards) {
      const out = cards.map((c): Card => {
        if (c.type !== "connection_request" || c.status !== "pending") return c;
        const before = raised.get(c.service) ?? start.get(c.service) ?? 0;
        return epochOf(core, userId, c.service) > before ? { ...c, status: "connected", action: continueAction(c.serviceName) } : c;
      });
      done();
      return out;
    },
    done,
  };
}

/** ids of the stored messages holding a pending `connection_request` card of `service` that are mine to resolve */
function pendingCardMessages(core: Core, userId: string, service: string): Set<string> {
  const ids = new Set<string>();
  for (const row of core.db.messagesWithCard(userId, "connection_request")) {
    if (row.author_user_id && row.author_user_id !== userId) continue;
    if (safeJson<Card[]>(row.cards_json, []).some((c) => c.type === "connection_request" && c.service === service && c.status === "pending")) ids.add(row.id);
  }
  return ids;
}

/**
 * Flip the stored pending `connection_request` cards of `service` to "connected" and push the updates. The newest one
 * offers 이어서 하기 (it sends "<서비스> 연결했어요. 이어서 해 주세요.") unless a turn picks the connect up itself: one was
 * waiting (`woke` > 0), or one was running with a card of this service when the connect was counted (`live` > 0: its
 * own card gets the action when stored). `only`: the messages stored before the connect (a card raised after it, e.g.
 * the retried call refused the new login, is not resolved by it).
 */
export function markConnectionCardsConnected(core: Core, userId: string, service: string, o: { woke: number; live: number; only?: Set<string> }): number {
  const touched = new Set<string>();
  let n = 0;
  let offered = o.woke > 0 || o.live > 0;
  for (const row of core.db.messagesWithCard(userId, "connection_request")) {
    // in shared threads, only my own agent's requests are mine to resolve
    if (row.author_user_id && row.author_user_id !== userId) continue;
    if (o.only && !o.only.has(row.id)) continue;
    const cards = safeJson<Card[]>(row.cards_json, []);
    let changed = false;
    const next = cards.map((c): Card => {
      if (c.type !== "connection_request" || c.service !== service || c.status !== "pending") return c;
      changed = true;
      if (offered) return { ...c, status: "connected" };
      offered = true; // newest first (messagesWithCard orders by created_at DESC)
      return { ...c, status: "connected", action: continueAction(c.serviceName) };
    });
    if (!changed) continue;
    core.db.updateMessageCards(row.id, next);
    publishMessage(core, row.id);
    touched.add(row.thread_id);
    n++;
  }
  for (const t of touched) publishThread(core, t);
  return n;
}

/** connected; saved but not verified yet (the upstream could not answer, re-checked later); or refused / failed */
export type KskillConnectOutcome =
  | { status: "connected"; accountLabel: string | null }
  | { status: "checking"; message: string }
  | { status: "error"; message: string };

type Verified = { ok: true; accountLabel?: string } | { ok: false; message: string; retryable: boolean };

/** registry verify, never throwing; `retryable` = the upstream could not answer (the login itself was not refused) */
async function verifyOnce(core: Core, userId: string, service: string, credentialId: string): Promise<Verified> {
  try {
    const v = await core.connections.verify(userId, service, { credentialId });
    if (v.ok) return v;
    return { ok: false, message: v.message, retryable: v.retryable === true };
  } catch (err) {
    core.log.warn("connection verify failed", { user: userId, service, err: errInfo(err) });
    return { ok: false, message: `${core.connections.serviceName(service)}에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.`, retryable: true };
  }
}

/** a verified new login: count the connect, wake the waiting turns (older rows drop), flip the stored cards */
async function connected(core: Core, userId: string, service: string, credentialId: string): Promise<number> {
  const st = stateOf(core);
  const k = keyOf(userId, service);
  settleUnconfirmed(core, userId, credentialId);
  // read with the count, before any await: the turns holding a card of this service right now, and the cards stored
  // before this connect (only those are resolved by it)
  const live = st.live.get(k) ?? 0;
  st.epoch.set(k, (st.epoch.get(k) ?? 0) + 1);
  const stored = pendingCardMessages(core, userId, service);
  let woke = 0;
  try {
    woke = await core.connections.notifyConnected(userId, service, { credentialId });
  } catch (err) {
    core.log.warn("connection notify failed", { user: userId, service, err: errInfo(err) });
  }
  markConnectionCardsConnected(core, userId, service, { woke, live, only: stored });
  core.log.info("connection", { user: userId, provider: service, status: "connected", woke });
  return woke;
}

/**
 * Remove a row this server saved and the upstream refused (best effort). When an older login of the service remains,
 * wake the turns waiting on it (no credentialId: nothing is dropped): one whose tool was refused by the removed row
 * excludes that row, finds the older one and retries.
 */
async function dropRefused(core: Core, userId: string, service: string, credentialId: string): Promise<void> {
  try {
    await core.deps.vault.remove(userId, credentialId);
  } catch (err) {
    core.log.warn("vault.remove after a refused verify failed", { user: userId, service, err: errInfo(err) });
    return;
  }
  try {
    if ((await core.connections.status(userId)).some((r) => r.service === service && r.connected)) await core.connections.notifyConnected(userId, service);
  } catch (err) {
    core.log.warn("connection notify failed", { user: userId, service, err: errInfo(err) });
  }
}

/** the next background verify of a saved login the upstream could not answer for (attempt = index into the delays) */
function scheduleRecheck(core: Core, userId: string, service: string, credentialId: string, attempt: number): void {
  const st = stateOf(core);
  const delays = recheckDelays(core, service);
  const k = keyOf(userId, credentialId);
  if (st.stopped || attempt >= delays.length) {
    st.recheck.delete(k);
    return;
  }
  const entry = st.recheck.get(k) ?? { timer: null };
  st.recheck.set(k, entry);
  const run = async () => {
    entry.timer = null;
    if (st.stopped || st.recheck.get(k) !== entry) return;
    // replaced (a newer login dropped it), disconnected or expired meanwhile: nothing left to check
    let row: CredentialInfo | undefined;
    try {
      row = (await core.deps.vault.list(userId)).find((r) => r.id === credentialId && r.service === service && !r.expired);
    } catch (err) {
      core.log.warn("connection recheck: vault.list failed", { user: userId, provider: service, err: errInfo(err) });
      if (attempt + 1 < delays.length) return scheduleRecheck(core, userId, service, credentialId, attempt + 1);
      st.recheck.delete(k);
      return;
    }
    if (!row) {
      settleUnconfirmed(core, userId, credentialId);
      return;
    }
    const v = await verifyOnce(core, userId, service, credentialId);
    if (st.stopped || st.recheck.get(k) !== entry) return;
    if (v.ok) {
      await connected(core, userId, service, credentialId);
      core.events.publish(userId, {
        type: "connection",
        connection: { provider: service, status: "connected", accountLabel: v.accountLabel ?? (row.hint || null), credentialId, lastError: null, connectedAt: row.createdAt, updatedAt: core.now() },
      });
      return;
    }
    if (v.retryable && attempt + 1 < delays.length) return scheduleRecheck(core, userId, service, credentialId, attempt + 1);
    if (v.retryable) {
      // still unreachable after the last try: the login stays, unconfirmed (a tool that gets refused raises the card;
      // a later {credentialId} check that passes is the connect)
      st.recheck.delete(k);
      core.log.warn("connection recheck gave up", { user: userId, provider: service, attempts: delays.length });
      await publishKskillState(core, userId, service);
      return;
    }
    settleUnconfirmed(core, userId, credentialId);
    await dropRefused(core, userId, service, credentialId);
    core.log.info("connection", { user: userId, provider: service, status: "error", recheck: attempt + 1 });
    const current = (await kskillConnectionRows(core, userId)).find((c) => c.provider === service);
    core.events.publish(userId, {
      type: "connection",
      connection: { provider: service, status: "error", accountLabel: current?.accountLabel ?? null, credentialId: current?.credentialId ?? null, lastError: v.message, connectedAt: current?.connectedAt ?? null, updatedAt: core.now() },
    });
  };
  entry.timer = timersOf(core).set(() => core.track(run()), delays[attempt]!);
}

/**
 * A login of `service` was saved (POST /api/connections/:service or POST /api/credentials; `created` false when the
 * request named an existing row with `{credentialId}`): verify it.
 *  - a new (or still unconfirmed) login that passes: the connect (wake waiting turns, flip cards);
 *  - an existing login that already worked and passes again: no new connect (a card its tool just raised stays);
 *  - refused: remove the row if it was never confirmed (never a login the owner already had);
 *  - the upstream could not answer: keep the row; an unconfirmed one is checked again later ("checking").
 * Never throws.
 */
export async function afterKskillSave(core: Core, userId: string, info: Pick<CredentialInfo, "id" | "service" | "hint">, o: { created: boolean }): Promise<KskillConnectOutcome> {
  const service = info.service;
  const st = stateOf(core);
  const k = keyOf(userId, info.id);
  const fresh = o.created || st.unconfirmed.has(k);
  const v = await verifyOnce(core, userId, service, info.id);
  if (v.ok) {
    if (fresh) await connected(core, userId, service, info.id);
    else core.log.info("connection", { user: userId, provider: service, status: "rechecked" });
    return { status: "connected", accountLabel: v.accountLabel ?? (info.hint || null) };
  }
  // (verify already dropped the failed credential's own session; an older working login keeps its session)
  if (v.retryable) {
    core.log.info("connection", { user: userId, provider: service, status: fresh ? "checking" : "unreachable" });
    if (!fresh) return { status: "error", message: `지금은 ${core.connections.serviceName(service)}에 확인하지 못했어요. 잠시 후 다시 시도해 주세요.` };
    st.unconfirmed.add(k);
    if (!st.recheck.has(k)) scheduleRecheck(core, userId, service, info.id, 0);
    return { status: "checking", message: recheckCopy(core.connections.serviceName(service)) };
  }
  if (fresh) {
    settleUnconfirmed(core, userId, info.id);
    await dropRefused(core, userId, service, info.id);
  }
  core.log.info("connection", { user: userId, provider: service, status: "error" });
  return { status: "error", message: v.message };
}

/**
 * The ConnectResponse for a k-skill connect, and (connected / checking) the matching `connection` event for the user's
 * other devices. "checking" is status "needs_verification" with the Korean line in lastError. A failure carries the
 * Korean line, plus the identity of a login of the service that still exists (so the app's row doesn't fall back to
 * 연결 전 while an older login keeps working).
 */
export async function kskillConnectResponse(core: Core, userId: string, service: string, info: Pick<CredentialInfo, "id" | "hint">, r: KskillConnectOutcome): Promise<ConnectResponse> {
  const now = core.now();
  if (r.status !== "error") {
    const connection: Connection =
      r.status === "connected"
        ? { provider: service, status: "connected", accountLabel: r.accountLabel, credentialId: info.id, lastError: null, connectedAt: now, updatedAt: now }
        : { provider: service, status: "needs_verification", accountLabel: info.hint || null, credentialId: info.id, lastError: r.message, connectedAt: now, updatedAt: now };
    core.events.publish(userId, { type: "connection", connection });
    return { connection };
  }
  const current = (await kskillConnectionRows(core, userId)).find((c) => c.provider === service);
  return {
    connection: {
      provider: service,
      status: "error",
      accountLabel: current?.accountLabel ?? null,
      credentialId: current?.credentialId ?? null,
      lastError: r.message,
      connectedAt: current?.connectedAt ?? null,
      updatedAt: now,
    },
  };
}

/** After a k-skill row went away outside DELETE /api/connections: push the service's state now (another login may remain). */
export async function publishKskillState(core: Core, userId: string, service: string): Promise<void> {
  const current = (await kskillConnectionRows(core, userId)).find((c) => c.provider === service);
  core.events.publish(userId, {
    type: "connection",
    connection: current ?? { provider: service, status: "disconnected", accountLabel: null, credentialId: null, lastError: null, connectedAt: null, updatedAt: core.now() },
  });
}

/**
 * GET /api/skills: a k-skill login tool is `configured` once its owner has connected the service (the skills package
 * lists them unconfigured; whether one is connected is per user).
 */
export async function skillsConfiguredFor<T extends { configured: boolean; connection?: string }>(core: Core, userId: string, rows: T[]): Promise<T[]> {
  if (!rows.some((r) => r.connection)) return rows;
  let live: Set<string>;
  try {
    live = new Set((await core.connections.status(userId)).filter((r) => r.connected).map((r) => r.service));
  } catch {
    return rows;
  }
  return rows.map((r) => (r.connection ? { ...r, configured: live.has(r.connection) } : r));
}

/** Shared threads: the prompt's skill list without the owner's login tools (buildTools drops those tools there). */
export function skillsWithoutLogins(core: Core, enabled: string[]): string[] | undefined {
  let rows: { id: string; connection?: string }[] = [];
  try {
    rows = core.deps.skills.listSkills();
  } catch {
    rows = [];
  }
  const logins = new Set(rows.filter((r) => r.connection).map((r) => r.id));
  if (!logins.size) return enabled.length ? enabled : undefined;
  return (enabled.length ? enabled : rows.map((r) => r.id)).filter((id) => !logins.has(id));
}

/** DELETE /api/connections/:service: upstream sign-out (best effort), then every row and cached session of it goes. */
export async function kskillDisconnect(core: Core, userId: string, service: string): Promise<{ removed: number }> {
  const res = await core.connections.revoke(userId, service);
  const now = core.now();
  core.events.publish(userId, {
    type: "connection",
    connection: { provider: service, status: "disconnected", accountLabel: null, credentialId: null, lastError: null, connectedAt: null, updatedAt: now },
  });
  core.log.info("connection", { user: userId, provider: service, status: "disconnected", removed: res.removed });
  return res;
}
