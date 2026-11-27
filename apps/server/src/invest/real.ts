/**
 * B3b: turning real stop orders on and off (team-lead 2040 10·11·13, 2342; DD 1935 §3-4 · §3-5, 2042-b §2 · §3 · §5,
 * 2044 §4 · §5). The person's own act from the app, never the model's: no tool reaches anything here.
 * - On: a preview lists what would be sold (each held symbol's watched sell stops, per rule, with the quantity Toss gives
 *   right then). The enable is signed with the person's device key over the approvals' message
 *   `approve:<previewId>:<nonce>`; the preview is the person's own, used once, for 10 minutes, and Toss is asked again:
 *   any change → 409 preview_stale. Each target is then confirmed at its rule's rev and that quantity; nothing else is.
 * - Off: no signature. Every confirmation goes, planned and waiting orders are dropped (no banner, no call), sent ones are
 *   still checked.
 * - A preview reads Toss once per held symbol: a live one of the same person is reused for 30 s, and a person makes at
 *   most 6 in 10 minutes (429). No Toss call while a blocker holds (the switch off, Toss paused or not connected).
 */
import type { InvestRealBlocker, InvestRealPreview, InvestRealTarget, InvestSettingsView } from "@pickle/protocol";
import { num, shares } from "@pickle/quant";
import type { Core } from "../core.ts";
import { bad, forbidden, HttpError } from "../http.ts";
import { errInfo } from "../log.ts";
import { newId } from "../util.ts";
import { marketOf } from "./calendar.ts";
import * as idb from "./db.ts";
import { bufferPct, DEFAULT_BUFFER_PCT, INTRADAY_ONLY, money } from "./rules.ts";

export const REAL_PREVIEW_TTL_MS = 10 * 60_000;
export const REAL_PREVIEW_REUSE_MS = 30_000;
export const REAL_PREVIEWS_PER_TTL = 6;

/** the 실제 주문 row's foot when it cannot be turned on (DD 2044 §4): the first that holds, in this order */
export const REAL_BLOCKER_TEXT: Readonly<Record<InvestRealBlocker, string>> = {
  orders_off: "실제 주문은 아직 준비 중이라 켤 수 없어요.",
  toss_not_connected: "토스증권을 연결하면 켤 수 있어요.",
  toss_off: "토스증권 접속이 풀리면 켤 수 있어요.",
  toss_ip_blocked: "토스증권 접속이 풀리면 켤 수 있어요.",
  toss_paused: "토스증권 접속이 풀리면 켤 수 있어요.",
  toss_never_ok: "토스증권 시세 확인이 한 번 성공하면 켤 수 있어요.",
};
const BLOCKER_ORDER: readonly InvestRealBlocker[] = ["orders_off", "toss_not_connected", "toss_off", "toss_ip_blocked", "toss_paused", "toss_never_ok"];

export function realBlockerText(blockers: readonly InvestRealBlocker[]): string | null {
  const first = BLOCKER_ORDER.find((b) => blockers.includes(b));
  return first ? REAL_BLOCKER_TEXT[first] : null;
}

/** the sheet's 409 and 403 lines (DD 2044 §4), the approvals' words for a malformed signature or an unknown device */
export const REAL_ERRORS = {
  real_blocked: (why: string) => `그사이 실제 주문을 켤 수 없게 됐어요. ${why}`,
  preview_stale: "그사이 보유 수량이나 규칙이 바뀌었어요. 바뀐 목록을 확인하고 다시 길게 눌러 주세요.",
  bad_signature: "기기 키로 확인하지 못해서 켜지 않았어요. 다시 길게 눌러 주세요.",
  invalid_signature: "기기 서명 정보가 올바르지 않아요",
  unknown_device: "등록되지 않은 기기예요",
  sellable_unknown: "토스증권에서 팔 수 있는 수량을 받지 못했어요. 잠시 뒤 다시 열어 주세요.",
  rate_limited: "요청이 많아요. 잠시 후 다시 시도해 주세요.",
} as const;

/** the conditions (DD 1935 §3-5 1–3 with 2042-b §3 after 1 and 2044 §4 after 2); the 4th follows the phone */
const CONDITIONS = [
  "정규장 시간에만 시장가로 내요. 조기 폐장일과 장 밖에서는 내지 않아요.",
  "종가 기준은 마감 뒤에야 알 수 있어서, 다음 거래일 개장 15분 뒤에 팔아요. 장중 기준 가격 아래로 내려가면 그때 바로 팔아요.",
  "체결 가격은 보장되지 않아요. 손절선보다 낮게 팔릴 수 있어요.",
  "켠 뒤에 보유가 늘어도, 여기서 확인한 수량까지만 팔아요.",
  "사는 주문, 익절 매도, 손절선 변경은 하지 않아요.",
] as const;
/**
 * condition 4 (DD 2044 §4, 0010-b 2, 0055 §3), the first that holds: the server cannot place calls (no advice: nothing the
 * person does makes a call go) → the phone not verified → the 손절 결과 call off → on
 */
const TELL_NO_CALLS = "체결되면 채팅으로 알려요.";
const TELL_VERIFIED = "체결되면 전화와 채팅으로 알려요.";
const TELL_CALL_OFF = "체결되면 채팅으로 알려요. 투자 설정에서 손절 결과 전화를 켜면 전화로도 알려요.";
const TELL_UNVERIFIED = "체결되면 채팅으로 알려요. 번호를 인증하면 전화로도 알려요.";
const EMPTY = { text: "지금은 손절 규칙이 있는 보유 종목이 없어요.", foot: "켠 뒤에 생기는 손절은 규칙 시트에서 길게 눌러 확인받아요." } as const;
const bufferFootText = (pct: number) => `장중 기준 가격은 손절선의 ${num(pct)}% 아래예요. 원문에 숫자가 없어서 정한 운영 기본값이에요.`;

interface Target {
  rule: idb.RuleRow;
  qty: number;
}
interface Read {
  targets: Target[];
  /** held nowhere: symbols with sell stops and 0 to sell, in rule order */
  notHeld: string[];
}
/** what a stored real preview keeps: what enable confirms, and the sheet as drawn (reused within 30 s) */
interface Saved {
  targets: { ruleId: string; rev: number; qty: number }[];
  view: Omit<InvestRealPreview, "previewId" | "expiresAt">;
}

const isTarget = (r: idb.RuleRow) => r.kind === "stop" && r.action === "sell" && (r.state === "armed" || r.state === "hit");

/**
 * Each symbol with a watched sell stop, asked once (one after another): > 0 → its stops are targets; 0 → held nowhere.
 * Any read that fails → 503 sellable_unknown: never a sheet with a guessed quantity.
 */
async function readTargets(core: Core, userId: string): Promise<Read> {
  const h = core.invest;
  const rules = idb.rules(core.db, userId).filter(isTarget);
  const qty = new Map<string, number>();
  for (const symbol of new Set(rules.map((r) => r.symbol))) {
    const q = await h.toss.sellable(userId, symbol);
    h.recordToss(userId, q.ok ? null : q.error, core.now());
    // readSellable: a number ≥ 0, or null when the body has none
    const n = q.ok ? q.value : null;
    if (n == null) throw new HttpError(503, "sellable_unknown", REAL_ERRORS.sellable_unknown);
    qty.set(symbol, n);
  }
  const targets: Target[] = [];
  const notHeld: string[] = [];
  for (const r of rules) {
    const n = qty.get(r.symbol)!;
    if (n > 0) targets.push({ rule: r, qty: n });
    else if (!notHeld.includes(r.symbol)) notHeld.push(r.symbol);
  }
  return { targets, notHeld };
}

/** the sheet's words for what was read: each stop's line by how the server judges it (close and intraday, or intraday) */
async function draw(core: Core, userId: string, read: Read): Promise<Saved["view"]> {
  const targets: InvestRealTarget[] = [];
  let defaultBuffer = false;
  for (const t of read.targets) {
    const r = t.rule;
    const m = marketOf(r.symbol);
    const pct = bufferPct(r);
    const c = await core.invest.stopContext(userId, r.symbol, r.price!, pct);
    let line: string;
    let note: string | null = null;
    if (c.basis === "close_and_intraday") {
      line = `종가 ${money(m, r.price!)} 이하 또는 장중 ${money(m, c.buffer)} 이하`;
      if (r.buffer_pct != null) line += ` · 장중 버퍼 ${num(pct)}%(직접 정함)`;
      else defaultBuffer = true;
    } else {
      line = `장중 ${money(m, r.price!)} 이하`;
      note = INTRADAY_ONLY;
    }
    targets.push({ ruleId: r.id, rev: r.rev, symbol: r.symbol, qty: { v: t.qty, text: shares(t.qty), unit: "qty" }, head: `${r.symbol} · ${shares(t.qty)} 전량`, line, note });
  }
  const block = core.invest.callBlock(userId);
  const callOn = core.invest.calls(idb.ensureSettings(core.db, userId, core.now())).stopResult;
  const tell = block === "not_configured" ? TELL_NO_CALLS : block === "not_verified" ? TELL_UNVERIFIED : callOn ? TELL_VERIFIED : TELL_CALL_OFF;
  return {
    targets,
    notHeld: read.notHeld.length ? `보유하지 않아 팔지 않아요: ${read.notHeld.join(", ")}` : null,
    bufferFoot: defaultBuffer ? bufferFootText(DEFAULT_BUFFER_PCT) : null,
    empty: targets.length ? null : { ...EMPTY },
    conditions: [...CONDITIONS, tell],
  };
}

async function store(core: Core, userId: string, read: Read): Promise<InvestRealPreview> {
  const view = await draw(core, userId, read);
  const id = newId("ip");
  const expiresAt = core.now() + REAL_PREVIEW_TTL_MS;
  const saved: Saved = { targets: read.targets.map((t) => ({ ruleId: t.rule.id, rev: t.rule.rev, qty: t.qty })), view };
  idb.putPreview(core.db, { id, user_id: userId, kind: "real", spec_json: JSON.stringify(saved), expires_at: expiresAt });
  return { previewId: id, expiresAt, ...view };
}

/** a new sheet is one of the person's 6 in 10 minutes */
function underCap(core: Core, userId: string): void {
  if (idb.realPreviewCount(core.db, userId, core.now()) >= REAL_PREVIEWS_PER_TTL) throw new HttpError(429, "rate_limited", REAL_ERRORS.rate_limited);
}

/** a blocker holds (the settings' own list and sentence): 409 real_blocked, before any Toss read */
async function blocked(core: Core, userId: string): Promise<void> {
  const why = (await core.invest.settingsView(userId)).realBlockerText;
  if (why) throw new HttpError(409, "real_blocked", REAL_ERRORS.real_blocked(why), undefined, { realBlockerText: why });
}

/** POST /api/invest/real/preview */
export async function realPreview(core: Core, userId: string): Promise<InvestRealPreview> {
  await blocked(core, userId);
  const now = core.now();
  const live = idb.liveRealPreview(core.db, userId, now + REAL_PREVIEW_TTL_MS - REAL_PREVIEW_REUSE_MS);
  if (live) {
    const saved = JSON.parse(live.spec_json) as Saved;
    return { previewId: live.id, expiresAt: live.expires_at, ...saved.view };
  }
  underCap(core, userId);
  return store(core, userId, await readTargets(core, userId));
}

/** what enable would confirm is what the sheet showed: the same rules at the same revs with the same quantities */
const sameRead = (saved: Saved, read: Read) => {
  const a = saved.targets.map((t) => `${t.ruleId}:${t.rev}:${t.qty}`).sort();
  const b = read.targets.map((t) => `${t.rule.id}:${t.rule.rev}:${t.qty}`).sort();
  return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * POST /api/invest/real/enable. In order: the signature's fields (400), the device and its signature (400 / 403), real
 * mode already on (200, nothing changes: a second press), the blockers (409 real_blocked), the person's own live unused
 * preview (409 preview_stale, nothing more said), Toss asked again (other rules, revs or quantities → 409
 * preview_stale with the new sheet), then in one step with no wait: every target still at its rev, the preview taken,
 * mode real, the person's confirmations replaced by the targets'. A replayed request finds its preview used (409) or
 * real mode on (200); a press whose preview another press took while it asked Toss is stale (409), even after a disable.
 */
export async function enableReal(core: Core, userId: string, body: Record<string, unknown>): Promise<InvestSettingsView> {
  const { previewId, deviceId, nonce, signature } = body;
  if (
    typeof previewId !== "string" ||
    typeof deviceId !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string" ||
    !previewId ||
    previewId.length > 64 ||
    !nonce ||
    nonce.length > 128 ||
    !signature ||
    signature.length > 256
  )
    throw bad(REAL_ERRORS.invalid_signature, "invalid_signature");
  const device = core.db.getDevice(userId, deviceId);
  if (!device) throw bad(REAL_ERRORS.unknown_device, "unknown_device");
  let ok = false;
  try {
    ok = await core.deps.verifyApproval(JSON.parse(device.signing_jwk) as JsonWebKey, previewId, nonce, signature);
  } catch (err) {
    core.log.warn("invest real enable verify error", { err: errInfo(err) });
  }
  if (!ok) throw forbidden(REAL_ERRORS.bad_signature, "bad_signature");
  const db = core.db;
  if (idb.ensureSettings(db, userId, core.now()).mode === "real") return core.invest.settingsView(userId);
  await blocked(core, userId);
  const row = idb.getPreview(db, userId, previewId, core.now());
  if (!row || row.kind !== "real") throw new HttpError(409, "preview_stale", REAL_ERRORS.preview_stale);
  const saved = JSON.parse(row.spec_json) as Saved;
  const read = await readTargets(core, userId);
  if (!sameRead(saved, read)) {
    underCap(core, userId);
    throw new HttpError(409, "preview_stale", REAL_ERRORS.preview_stale, undefined, { preview: await store(core, userId, read) });
  }
  const now = core.now();
  const outcome = db.tx((): "ok" | "on" | "stale" => {
    if (idb.ensureSettings(db, userId, now).mode === "real") return "on";
    // a rule saved while Toss was asked again (its rev moved): not what the sheet showed
    for (const t of saved.targets) {
      const r = idb.rule(db, userId, t.ruleId);
      if (!r || r.rev !== t.rev) return "stale";
    }
    // taken by another press since the read (it turned real on, and the person may have turned it off again): stale.
    // This is also what makes a nonce single use (lead 2342, 0310)
    if (!idb.usePreview(db, previewId, now)) return "stale";
    idb.updateSettings(db, userId, { mode: "real", real_since: now }, now);
    idb.clearConfirms(db, userId);
    for (const t of saved.targets) idb.confirmReal(db, userId, t.ruleId, t.rev, t.qty, now);
    return "ok";
  });
  if (outcome === "stale") throw new HttpError(409, "preview_stale", REAL_ERRORS.preview_stale);
  if (outcome === "ok") {
    const held = bySymbol(saved.targets.map((t) => ({ symbol: idb.rule(db, userId, t.ruleId)!.symbol, qty: t.qty })));
    const shown = !held.length ? "지금은 대상 없음" : held.length <= 2 ? held.join(" · ") : `${held[0]} 외 ${held.length - 1}종목`;
    core.invest.recordEvent(userId, `실제 주문을 켰어요 · ${shown}`, `[투자 기록] 실제 주문 켬 · ${held.length ? `대상 ${held.join(", ")}` : "대상 없음"}`);
  }
  await core.invest.publish(userId);
  return core.invest.settingsView(userId);
}

/** `SOXL 47주, TQQQ 3주`: one per symbol (its stops share the quantity) */
/** `SOXL 47주` per symbol, in the sheet's order (a symbol's stops share its quantity) */
function bySymbol(list: { symbol: string; qty: number }[]): string[] {
  const seen = new Map<string, number>();
  for (const x of list) if (!seen.has(x.symbol)) seen.set(x.symbol, x.qty);
  return [...seen].map(([s, q]) => `${s} ${shares(q)}`);
}

/** POST /api/invest/real/disable: no signature (the safe side); already off → nothing changes */
export async function disableReal(core: Core, userId: string): Promise<InvestSettingsView> {
  const db = core.db;
  const now = core.now();
  if (idb.ensureSettings(db, userId, now).mode === "real") {
    db.tx(() => {
      idb.updateSettings(db, userId, { mode: "mock", real_since: null }, now);
      idb.clearConfirms(db, userId);
    });
    const dropped = core.invest.desk.dropPlanned(userId, "disabled", now);
    const sent = idb.openOrders(db, userId);
    const parts = [dropped ? `예정 주문 ${dropped}건 취소` : null, sent ? `보낸 주문 ${sent}건 체결 확인 중` : null].filter((x): x is string => !!x);
    core.invest.recordEvent(userId, ["실제 주문을 껐어요", ...parts].join(" · "), ["[투자 기록] 실제 주문 끔", ...parts].join(" · "));
  }
  await core.invest.publish(userId);
  return core.invest.settingsView(userId);
}
