/**
 * 팝빌 전자세금계산서 with the owner's own LinkID / SecretKey / 사업자번호.
 *
 * The protocol is ported from the MIT-licensed Linkhub SDKs that NomaDamas/k-skill `popbill` (MIT) drives
 * (linkhub 1.6.0 `linkhub.py`, popbill 1.64.2 `base.py` / `taxinvoiceService.py`, © 2014 Linkhub):
 *  - token: POST https://auth.linkhub.co.kr/{POPBILL|POPBILL_TEST}/Token, body {"access_id": corpNum, "scope": [...]},
 *    headers x-lh-date (UTC ISO, seconds) / x-lh-version 2.0 / Authorization "LINKHUB {LinkID} {hmac}", where hmac =
 *    base64(HMAC-SHA256(base64decode(SecretKey), "POST\n" + base64(sha256(body)) + "\n" + date + "\n2.0\n/{SID}/Token"))
 *    (IP restriction on: no forwarded IP line, the SDK default);
 *  - API: https://popbill[-test].linkhub.co.kr, Bearer session_token, x-pb-version 1.0; registIssue = POST /Taxinvoice
 *    with X-HTTP-Method-Override: ISSUE; search = GET /Taxinvoice/{SELL|BUY}?DType&SDate&EDate…; point balance =
 *    GET https://auth.linkhub.co.kr/{SID}/Point.
 * Like the upstream CLI, the test environment is the default and issuing always needs the owner's approval.
 */
import type { ApprovalSpec, ConnectionHandle, ConnectionServiceContext } from "@pickle/agent";
import { needsConnection } from "@pickle/agent";
import type { ResultListCard } from "@pickle/protocol";
import { addDays, defineSkill, failText, kst, schema, str, type Args, type SkillConnection } from "../util";
import { bizNo, directRequest, fromDirect, hmacSha256, parseJson, sha256Base64, shortHash, verifyFailure, type UpstreamFailure, type VerifyResult } from "../direct";

export const LINKHUB_AUTH = "https://auth.linkhub.co.kr";
export const POPBILL_TEST = "https://popbill-test.linkhub.co.kr";
export const POPBILL_REAL = "https://popbill.linkhub.co.kr";
const ORIGINS = [LINKHUB_AUTH, POPBILL_TEST, POPBILL_REAL] as const;
const TAXINVOICE_SCOPE = ["member", "110"];

export const POPBILL: SkillConnection = {
  id: "popbill",
  name: "팝빌",
  reason: "전자세금계산서를 다루려면 팝빌 연결이 필요해요",
};

type Secret = Readonly<Record<string, string>>;
type Out<T> = { ok: true; body: T } | { ok: false; error: UpstreamFailure };
type PopbillConn = Pick<ConnectionHandle, "secret" | "session" | "credentialId">;

export interface PopbillConfig {
  linkId: string;
  secretKey: string;
  corpNum: string;
  /** optional 팝빌 아이디 (sent as x-pb-userid, like the SDK's UserID argument) */
  userId?: string;
  test: boolean;
}

/** "운영"/"real"/"production" → production; anything else (default "테스트") → the test environment */
export function popbillConfig(s: Secret): PopbillConfig | null {
  const linkId = (s.linkId ?? "").trim();
  const secretKey = (s.secretKey ?? "").trim();
  const corpNum = (s.corpNum ?? "").replace(/\D/g, "");
  if (!linkId || !secretKey || corpNum.length !== 10) return null;
  const env = (s.env ?? "").trim().toLowerCase();
  const userId = (s.userId ?? "").trim();
  return { linkId, secretKey, corpNum, ...(userId ? { userId } : {}), test: !/^(운영|실서비스|real|prod|production)$/.test(env) };
}

const sid = (c: PopbillConfig) => (c.test ? "POPBILL_TEST" : "POPBILL");
const apiOrigin = (c: PopbillConfig) => (c.test ? POPBILL_TEST : POPBILL_REAL);
const envLabel = (c: PopbillConfig) => (c.test ? "테스트" : "운영");

/** UTC "YYYY-MM-DDTHH:MM:SSZ" (no millis), the x-lh-date format */
export function linkhubDate(now: number): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** the Authorization signature of a Linkhub token request (see the module comment) */
export function linkhubSignature(secretKeyB64: string, body: string, date: string, serviceId: string): string {
  const target = `POST\n${sha256Base64(body)}\n${date}\n2.0\n/${serviceId}/Token`;
  return hmacSha256(Buffer.from(secretKeyB64, "base64"), target, "base64");
}

interface PopbillSession {
  token: string;
  exp: number;
  key: string; // `${env}:${corpNum}` the token was issued for
}

// single flight per connection session: the search and the point balance run in parallel and share one token request
const issuing = new WeakMap<object, Promise<Out<string>>>();

function issueToken(c: PopbillConfig, session: PopbillConn["session"], signal: AbortSignal): Promise<Out<string>> {
  const busy = issuing.get(session);
  if (busy) return busy;
  const p = requestToken(c, session, signal).finally(() => issuing.delete(session));
  issuing.set(session, p);
  return p;
}

async function requestToken(c: PopbillConfig, session: PopbillConn["session"], signal: AbortSignal, now: () => number = Date.now): Promise<Out<string>> {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(c.secretKey)) return { ok: false, error: { kind: "auth", message: "팝빌 SecretKey 형식이 맞지 않아요" } };
  const body = JSON.stringify({ access_id: c.corpNum, scope: TAXINVOICE_SCOPE });
  const date = linkhubDate(now());
  const r = await directRequest({
    url: `${LINKHUB_AUTH}/${sid(c)}/Token`,
    method: "POST",
    headers: { "x-lh-date": date, "x-lh-version": "2.0", Authorization: `LINKHUB ${c.linkId} ${linkhubSignature(c.secretKey, body, date, sid(c))}`, "Content-Type": "application/json" },
    body,
    origins: ORIGINS,
    signal,
  });
  if (!r.ok) return { ok: false, error: fromDirect(r.error, "팝빌") };
  const j = parseJson(r.res.text) as { session_token?: string; expiration?: string; code?: number; message?: string } | null | undefined;
  if (r.res.status === 200 && j?.session_token) {
    const exp = Date.parse(j.expiration ?? "") || now() + 30 * 60_000;
    const ttl = Math.max(30_000, exp - now() - 60_000);
    session.set({ token: j.session_token, exp: now() + ttl, key: `${sid(c)}:${c.corpNum}` } satisfies PopbillSession, ttl);
    return { ok: true, body: j.session_token };
  }
  const code = typeof j?.code === "number" ? String(j.code) : undefined;
  if (r.res.status === 429) return { ok: false, error: { kind: "rate", status: 429, code, message: "팝빌 요청이 많아 잠시 후에 다시 할 수 있어요" } };
  // every other refused token request is a login problem: wrong LinkID/SecretKey, or this 사업자번호 isn't a member here
  if (r.res.status >= 400 && r.res.status < 500) return { ok: false, error: { kind: "auth", status: r.res.status, code, message: tokenMessage(j?.code, c) } };
  return { ok: false, error: { kind: "upstream", status: r.res.status, code, message: "팝빌 인증 서버 응답이 원활하지 않아요" } };
}

function tokenMessage(code: unknown, c: PopbillConfig): string {
  if (code === -99003008 || code === -99003001) return `${envLabel(c)} 환경에 이 사업자번호의 연동회원이 없어요`;
  return `팝빌이 연동 정보(LinkID·SecretKey)를 받지 않았어요 (${envLabel(c)} 환경)`;
}

async function token(conn: PopbillConn, c: PopbillConfig, signal: AbortSignal): Promise<Out<string>> {
  const s = conn.session.get<PopbillSession>();
  if (s?.token && s.key === `${sid(c)}:${c.corpNum}` && s.exp > Date.now()) return { ok: true, body: s.token };
  return issueToken(c, conn.session, signal);
}

async function popbillCall<T>(conn: PopbillConn, c: PopbillConfig, o: { method?: "GET" | "POST"; url: string; body?: string; override?: string }, signal: AbortSignal): Promise<Out<T>> {
  const t = await token(conn, c, signal);
  if (!t.ok) return t;
  const headers: Record<string, string> = { Authorization: `Bearer ${t.body}`, "x-pb-version": "1.0", Accept: "application/json" };
  if (c.userId) headers["x-pb-userid"] = c.userId;
  if (o.body !== undefined) headers["Content-Type"] = "application/json; charset=utf8";
  if (o.override) headers["X-HTTP-Method-Override"] = o.override;
  const r = await directRequest({ url: o.url, method: o.method ?? "GET", headers, body: o.body, origins: ORIGINS, signal, limit: { key: `popbill:${conn.credentialId}`, burst: 6, refill: 30, windowMs: 60_000 } });
  if (!r.ok) return { ok: false, error: fromDirect(r.error, "팝빌") };
  const j = parseJson(r.res.text) as (T & { code?: number; message?: string }) | null | undefined;
  if (r.res.status === 200 && j !== undefined && j !== null) return { ok: true, body: j as T };
  const code = typeof j?.code === "number" ? j.code : undefined;
  const message = str(j?.message, 160) || "팝빌 서버 응답이 원활하지 않아요";
  if (r.res.status === 401) {
    conn.session.clear();
    return { ok: false, error: { kind: "auth", status: 401, code: code !== undefined ? String(code) : undefined, message } };
  }
  const kind = r.res.status === 429 ? "rate" : r.res.status >= 500 ? "upstream" : "input";
  return { ok: false, error: { kind, status: r.res.status, code: code !== undefined ? String(code) : undefined, message } };
}

/** connect-time check: a token for this 사업자번호, then the point balance (label = env + masked number) */
export async function verifyPopbill(secret: Secret, x: ConnectionServiceContext): Promise<VerifyResult> {
  const c = popbillConfig(secret);
  if (!c) return { ok: false, message: "LinkID, SecretKey, 사업자번호(10자리)를 모두 입력해 주세요." };
  const t = await issueToken(c, x.session, x.signal);
  if (!t.ok) return verifyFailure(t.error, `${t.error.message}. 값을 확인해 주세요.`);
  return { ok: true, accountLabel: `팝빌 ${envLabel(c)} · ${bizNo(c.corpNum).replace(/^(\d{3})-(\d{2})-\d{3}(\d{2})$/, "$1-$2-***$3")}` };
}

function failed(e: UpstreamFailure, conn: PopbillConn) {
  if (e.kind === "auth") {
    conn.session.clear();
    return needsConnection(POPBILL.id, POPBILL.name, `${e.message}. 팝빌을 다시 연결해 주세요.`);
  }
  return failText(`팝빌: ${e.message}${e.code ? ` (${e.code})` : ""}`, e.kind);
}

// ───────────────────────────── search ─────────────────────────────

const STATE: Record<string, string> = { "1": "임시저장", "2": "승인대기", "3": "발행완료", "4": "거부", "5": "취소", "6": "발행취소" };

interface InvoiceInfo {
  writeDate?: string;
  issueDT?: string;
  stateCode?: number;
  invoicerCorpName?: string;
  invoicerCorpNum?: string;
  invoiceeCorpName?: string;
  invoiceeCorpNum?: string;
  supplyCostTotal?: string;
  taxTotal?: string;
  totalAmount?: string;
  ntsconfirmNum?: string;
  invoicerMgtKey?: string;
  itemKey?: string;
}

const amount = (v: unknown) => {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/,/g, "")) : Number.NaN;
  return Number.isFinite(x) ? x : 0;
};
const won = (v: number) => `₩${Math.round(v).toLocaleString("en-US")}`;

function monthRange(p: string, now: Date): { since: string; until: string; label: string } {
  const t = kst(now);
  const mm = (m: number) => String(m).padStart(2, "0");
  if (p === "last_month") {
    const y = t.m === 1 ? t.y - 1 : t.y;
    const m = t.m === 1 ? 12 : t.m - 1;
    return { since: `${y}${mm(m)}01`, until: `${y}${mm(m)}${mm(new Date(Date.UTC(y, m, 0)).getUTCDate())}`, label: "지난달" };
  }
  if (p === "last30") return { since: addDays(t.ymd, -30), until: t.ymd, label: "최근 30일" };
  return { since: `${t.y}${mm(t.m)}01`, until: t.ymd, label: "이번 달" };
}

export const kPopbillInvoices = defineSkill({
  name: "k_popbill_invoices",
  description:
    "The owner's 전자세금계산서 in 팝빌: issued (sell, default) or received (buy) for a period, with totals, plus the remaining 팝빌 point. " +
    "Needs the owner's 팝빌 connection. `period`: this_month (default) | last_month | last30; optional `query` = 거래처 name or 사업자번호. Read-only.",
  parameters: schema({
    direction: { type: "string", enum: ["sell", "buy"], description: "sell = 매출(발행), buy = 매입(수신); default sell" },
    period: { type: "string", enum: ["this_month", "last_month", "last30"], description: "default this_month (by 작성일)" },
    query: { type: "string", description: "optional counterparty name or business number" },
  }),
  icon: "doc",
  title: (a) => (a.direction === "buy" ? "매입 세금계산서 확인" : "매출 세금계산서 확인"),
  meta: { source: "popbill", title: "팝빌 세금계산서 조회", description: "내 팝빌 계정의 매출·매입 전자세금계산서를 봐요.", category: "비즈니스", example: "이번 달 발행한 세금계산서 합계 얼마야?" },
  connection: POPBILL,
  private: true,
  async run(a, rc) {
    const conn = rc.conn!;
    const c = popbillConfig(conn.secret);
    if (!c) return needsConnection(POPBILL.id, POPBILL.name, "팝빌 연결 정보가 비어 있어요. 다시 연결해 주세요.");
    const buy = a.direction === "buy";
    const range = monthRange(str(a.period, 12), rc.now);
    const q = str(a.query, 40);
    const qs = new URLSearchParams({ DType: "W", SDate: range.since, EDate: range.until, Page: "1", PerPage: "50", Order: "D" });
    if (q) qs.set("QString", q);
    rc.status("팝빌 세금계산서 조회 중");
    const [r, point] = await Promise.all([
      popbillCall<{ total?: number; list?: InvoiceInfo[] }>(conn, c, { url: `${apiOrigin(c)}/Taxinvoice/${buy ? "BUY" : "SELL"}?${qs}` }, rc.signal),
      popbillCall<{ remainPoint?: number | string }>(conn, c, { url: `${LINKHUB_AUTH}/${sid(c)}/Point` }, rc.signal),
    ]);
    if (!r.ok) return failed(r.error, conn);
    const list = (r.body.list ?? []).map((i) => ({
      date: i.writeDate,
      state: STATE[String(i.stateCode ?? "").slice(0, 1)] ?? String(i.stateCode ?? ""),
      counterparty: buy ? i.invoicerCorpName : i.invoiceeCorpName,
      counterpartyNo: bizNo((buy ? i.invoicerCorpNum : i.invoiceeCorpNum) ?? ""),
      supply: amount(i.supplyCostTotal),
      tax: amount(i.taxTotal),
      total: amount(i.totalAmount),
      ntsConfirm: i.ntsconfirmNum || undefined,
      mgtKey: i.invoicerMgtKey || undefined,
    }));
    const issued = list.filter((i) => i.state === "발행완료");
    const sum = issued.reduce((s, i) => s + i.total, 0);
    const total = typeof r.body.total === "number" ? r.body.total : list.length;
    const label = buy ? "매입" : "매출";
    const remain = point.ok ? amount(point.body.remainPoint) : null;
    const card: ResultListCard = {
      type: "results",
      title: `${range.label} ${label} 세금계산서`,
      source: `팝빌 ${envLabel(c)}`,
      items: list.slice(0, 10).map((i) => ({
        title: `${i.counterparty ?? "-"} ${won(i.total)}`,
        subtitle: [i.date ? `${i.date.slice(4, 6)}/${i.date.slice(6, 8)}` : "", i.state, `공급가액 ${won(i.supply)}`].filter(Boolean).join(" · "),
        meta: i.counterpartyNo || undefined,
        icon: "doc",
      })),
    };
    return {
      ok: true,
      summary: total ? `${range.label} ${label} ${total}건 · 발행완료 합계 ${won(sum)}` : `${range.label} ${label} 세금계산서가 없어요`,
      data: {
        environment: envLabel(c),
        direction: buy ? "buy" : "sell",
        period: range,
        total,
        issuedTotal: sum,
        invoices: list.slice(0, 25),
        remainPoint: remain,
        note: c.test ? "팝빌 테스트 환경이라 실제 국세청 데이터가 아니에요." : undefined,
        private: true,
      },
      card: list.length ? card : undefined,
    };
  },
});

// ───────────────────────────── issue (write) ─────────────────────────────

interface IssueItem {
  name: string;
  supply: number;
  tax: number;
  qty?: number;
  unitCost?: number;
}

export interface IssueInput {
  invoiceeCorpNum: string;
  invoiceeName: string;
  invoiceeCeo: string;
  invoiceeEmail?: string;
  items: IssueItem[];
  supplyTotal: number;
  taxTotal: number;
  total: number;
  writeDate: string;
  purpose: "청구" | "영수";
  taxType: "과세" | "영세";
}

/** Validate the model's args into an invoice (no secret involved). `null` + reason when something is off. */
export function issueInput(a: Args, now: Date): { ok: true; v: IssueInput } | { ok: false; reason: string } {
  const corp = str(a.invoiceeCorpNum, 20).replace(/\D/g, "");
  if (corp.length !== 10) return { ok: false, reason: "공급받는자 사업자번호 10자리가 필요해요" };
  const name = str(a.invoiceeName, 70);
  const ceo = str(a.invoiceeCeo, 30);
  if (!name || !ceo) return { ok: false, reason: "공급받는자 상호와 대표자명이 필요해요" };
  const email = str(a.invoiceeEmail, 100);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: "공급받는자 이메일 형식이 맞지 않아요" };
  const taxType = a.taxType === "영세" ? "영세" : "과세";
  const raw = Array.isArray(a.items) ? a.items.slice(0, 99) : [];
  const items: IssueItem[] = [];
  for (const it of raw) {
    const o = (it ?? {}) as Record<string, unknown>;
    const itemName = str(o.name, 100);
    const supply = Math.round(Number(o.supplyCost));
    if (!itemName || !Number.isFinite(supply) || supply < 0) return { ok: false, reason: "품목마다 품목명과 공급가액(0 이상의 원 단위)이 필요해요" };
    const tax = o.tax !== undefined && o.tax !== null && Number.isFinite(Number(o.tax)) ? Math.round(Number(o.tax)) : taxType === "과세" ? Math.floor(supply * 0.1) : 0;
    const qty = Number.isFinite(Number(o.qty)) && Number(o.qty) > 0 ? Number(o.qty) : undefined;
    items.push({ name: itemName, supply, tax, qty, unitCost: qty ? Math.round(supply / qty) : undefined });
  }
  if (!items.length) return { ok: false, reason: "품목을 하나 이상 알려주세요" };
  const supplyTotal = items.reduce((s, i) => s + i.supply, 0);
  const taxTotal = items.reduce((s, i) => s + i.tax, 0);
  if (supplyTotal <= 0) return { ok: false, reason: "공급가액 합계가 0원이에요" };
  const today = kst(now).ymd;
  const wd = str(a.writeDate, 10).replace(/\D/g, "") || today;
  if (!/^\d{8}$/.test(wd) || wd > today || wd < addDays(today, -40)) return { ok: false, reason: "작성일은 오늘이나 최근 날짜(YYYYMMDD)여야 해요" };
  return {
    ok: true,
    v: { invoiceeCorpNum: corp, invoiceeName: name, invoiceeCeo: ceo, invoiceeEmail: email || undefined, items, supplyTotal, taxTotal, total: supplyTotal + taxTotal, writeDate: wd, purpose: a.purpose === "영수" ? "영수" : "청구", taxType },
  };
}

/** deterministic per invoice: a retried approved call can't issue twice (팝빌 refuses a reused 문서번호) */
export function mgtKeyFor(v: IssueInput): string {
  return `MOSI-${v.writeDate}-${shortHash(JSON.stringify(v), 8).toUpperCase()}`;
}

interface CorpInfo {
  ceoname?: string;
  corpName?: string;
  addr?: string;
  bizType?: string;
  bizClass?: string;
}

export function invoiceBody(v: IssueInput, me: { corpNum: string; info: CorpInfo }): Record<string, unknown> {
  return {
    writeDate: v.writeDate,
    chargeDirection: "정과금",
    issueType: "정발행",
    purposeType: v.purpose,
    taxType: v.taxType,
    invoicerCorpNum: me.corpNum,
    invoicerMgtKey: mgtKeyFor(v),
    invoicerCorpName: me.info.corpName ?? "",
    invoicerCEOName: me.info.ceoname ?? "",
    invoicerAddr: me.info.addr ?? "",
    invoicerBizType: me.info.bizType ?? "",
    invoicerBizClass: me.info.bizClass ?? "",
    invoiceeType: "사업자",
    invoiceeCorpNum: v.invoiceeCorpNum,
    invoiceeCorpName: v.invoiceeName,
    invoiceeCEOName: v.invoiceeCeo,
    invoiceeEmail1: v.invoiceeEmail ?? "",
    supplyCostTotal: String(v.supplyTotal),
    taxTotal: String(v.taxTotal),
    totalAmount: String(v.total),
    detailList: v.items.map((i, n) => ({
      serialNum: n + 1,
      purchaseDT: v.writeDate,
      itemName: i.name,
      qty: i.qty !== undefined ? String(i.qty) : "",
      unitCost: i.unitCost !== undefined ? String(i.unitCost) : "",
      supplyCost: String(i.supply),
      tax: String(i.tax),
    })),
  };
}

const ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const, description: "품목명" },
    supplyCost: { type: "integer" as const, description: "공급가액 (KRW, VAT excluded)" },
    tax: { type: "integer" as const, description: "세액; omit for 10% of supplyCost (과세)" },
    qty: { type: "number" as const, description: "optional quantity" },
  },
  required: ["name", "supplyCost"],
};

export const kPopbillIssueInvoice = defineSkill({
  name: "k_popbill_issue_invoice",
  description:
    "Issue (정발행) one 전자세금계산서 through the owner's 팝빌 account. ALWAYS asks the owner to approve first; irreversible once issued " +
    "(in the 운영 environment it is sent to 국세청). Needs the owner's 팝빌 connection. Ask the owner for any missing field instead of guessing: " +
    "공급받는자 사업자번호/상호/대표자명, items with 공급가액. Tax defaults to 10% (과세).",
  parameters: schema(
    {
      invoiceeCorpNum: { type: "string", description: "공급받는자 사업자번호 (10 digits)" },
      invoiceeName: { type: "string", description: "공급받는자 상호" },
      invoiceeCeo: { type: "string", description: "공급받는자 대표자명" },
      invoiceeEmail: { type: "string", description: "optional email that receives the invoice" },
      items: { type: "array", description: "1–99 line items", items: ITEM_SCHEMA },
      writeDate: { type: "string", description: "작성일 YYYYMMDD; default today (KST)" },
      purpose: { type: "string", enum: ["청구", "영수"], description: "default 청구" },
      taxType: { type: "string", enum: ["과세", "영세"], description: "default 과세" },
    },
    ["invoiceeCorpNum", "invoiceeName", "invoiceeCeo", "items"],
  ),
  icon: "doc",
  title: (a) => `${str(a.invoiceeName, 16) || "거래처"} 세금계산서 발행`,
  meta: { source: "popbill", title: "팝빌 세금계산서 발행", description: "승인을 받은 뒤 팝빌로 전자세금계산서를 발행해요.", category: "비즈니스", example: "하늘상사에 330만원 세금계산서 끊어줘" },
  connection: { ...POPBILL, reason: "세금계산서를 발행하려면 팝빌 연결이 필요해요" },
  private: true,
  write: true,
  approval(a): ApprovalSpec {
    // shown on the owner's approval card; the environment is decided by the connection, so the card says both
    const p = issueInput(a, new Date());
    if (!p.ok) return { title: "팝빌로 세금계산서를 발행할까요?", detail: `입력을 확인해 주세요: ${p.reason}` };
    const v = p.v;
    const lines = v.items.slice(0, 3).map((i) => `${i.name} ${won(i.supply)}`);
    if (v.items.length > 3) lines.push(`외 ${v.items.length - 3}건`);
    return {
      title: `${v.invoiceeName}에 세금계산서 ${won(v.total)}을 발행할까요?`,
      detail: [
        `공급받는자 ${v.invoiceeName} (${bizNo(v.invoiceeCorpNum)}) · 대표 ${v.invoiceeCeo}`,
        `품목 ${lines.join(", ")}`,
        `공급가액 ${won(v.supplyTotal)} · 세액 ${won(v.taxTotal)} · 합계 ${won(v.total)} (${v.taxType}, ${v.purpose})`,
        `작성일 ${v.writeDate.slice(0, 4)}-${v.writeDate.slice(4, 6)}-${v.writeDate.slice(6, 8)}`,
        "발행하면 되돌릴 수 없어요. 운영 환경이면 국세청으로 전송돼요.",
      ].join("\n"),
      amount: v.total,
    };
  },
  async run(a, rc) {
    const conn = rc.conn!;
    const c = popbillConfig(conn.secret);
    if (!c) return needsConnection(POPBILL.id, POPBILL.name, "팝빌 연결 정보가 비어 있어요. 다시 연결해 주세요.");
    const p = issueInput(a, rc.now);
    if (!p.ok) return failText(`팝빌: ${p.reason}`);
    rc.status("공급자 정보 확인 중");
    const info = await popbillCall<CorpInfo>(conn, c, { url: `${apiOrigin(c)}/CorpInfo` }, rc.signal);
    if (!info.ok) return failed(info.error, conn);
    if (!info.body.corpName || !info.body.ceoname) return failText("팝빌: 내 회사 정보(상호·대표자)가 팝빌에 없어요. 팝빌에서 회사 정보를 먼저 채워 주세요.", "corp_info_missing");
    const body = invoiceBody(p.v, { corpNum: c.corpNum, info: info.body });
    rc.status(`팝빌 ${envLabel(c)} 환경에 발행 중`);
    const r = await popbillCall<{ code?: number; message?: string; ntsConfirmNum?: string }>(conn, c, { method: "POST", url: `${apiOrigin(c)}/Taxinvoice`, body: JSON.stringify(body), override: "ISSUE" }, rc.signal);
    if (!r.ok) {
      const dup = r.error.code === "-11000005" || /이미 사용중|중복/.test(r.error.message);
      if (dup) return failText("팝빌: 같은 내용의 세금계산서가 이미 발행돼 있어요(문서번호 중복). 다시 발행하지 않았어요.", "duplicate", { mgtKey: mgtKeyFor(p.v) });
      return failed(r.error, conn);
    }
    return {
      ok: true,
      summary: `${p.v.invoiceeName}에 ${won(p.v.total)} 세금계산서를 발행했어요 (${envLabel(c)})`,
      data: { issued: true, environment: envLabel(c), mgtKey: mgtKeyFor(p.v), ntsConfirmNum: r.body.ntsConfirmNum, total: p.v.total, invoicee: p.v.invoiceeName, message: str(r.body.message, 80) || undefined },
      card: {
        type: "results",
        title: "세금계산서 발행",
        source: `팝빌 ${envLabel(c)}`,
        items: [
          { title: `${p.v.invoiceeName} ${won(p.v.total)}`, subtitle: `공급가액 ${won(p.v.supplyTotal)} · 세액 ${won(p.v.taxTotal)}`, meta: r.body.ntsConfirmNum ? `승인번호 ${r.body.ntsConfirmNum}` : mgtKeyFor(p.v), icon: "doc" },
        ],
      },
    };
  },
});

export const POPBILL_FIELDS = [
  { key: "linkId", label: "LinkID", type: "text" as const, autocomplete: "off", placeholder: "팝빌 연동 신청 때 받은 LinkID" },
  { key: "secretKey", label: "SecretKey", type: "password" as const, autocomplete: "off" },
  { key: "corpNum", label: "사업자번호", type: "text" as const, autocomplete: "off", placeholder: "연동회원 사업자번호 10자리" },
  { key: "userId", label: "팝빌 아이디", type: "text" as const, autocomplete: "off", optional: true, placeholder: "팝빌 사이트 로그인 아이디" },
  { key: "env", label: "환경", type: "text" as const, autocomplete: "off", optional: true, placeholder: "테스트 또는 운영", hint: "비워 두면 ‘테스트’예요. ‘운영’이면 국세청에 실제로 전송돼요." },
];
