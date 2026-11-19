/**
 * QA server for the k-skill accounts UI (kakao-chat). The REAL app server (buildDeps + createApp, its own data dir, no
 * LLM key) with stand-ins for the parts other teammates are still landing (docs/architecture/KSKILL-CONNECTIONS.md):
 *
 *   GET    /api/connections        the real answer + synthetic k-skill providers (category "korea") and their rows
 *   POST   /api/connections/:id    for those ids: the envelope is OPENED with the real enclave and the AAD
 *          `${userId}:${id}:${kind}` checked (proves the phone sealed it; plaintext is refused 400). A value equal to
 *          "qa-refused" answers 200 + status "error" + a Korean lastError, like a refused key upstream;
 *          "qa-unreachable" answers 200 + status "needs_verification" (kept, re-checked later), like an upstream timeout.
 *   DELETE /api/connections/:id    revoke (drops the row)
 *   POST   /qa/skill/seed          { service, status, accountLabel?, lastError? } — set a row directly
 *   POST   /qa/skill/extras        { on } — this account also gets the four developer-key services (none is listed today)
 *   POST   /qa/skill/bare          { on } — this account sees the app's own answer untouched (no stand-ins): at 8d8b535
 *                                  the server doesn't list k-skill services yet, and the screen must cope
 *   runTurn                        any message posts a pending connection_request card for 토스증권 and one line;
 *                                  "…연결했어요…" (이어서 하기) answers one line, no card; "문장 확인" posts one pending
 *                                  card per catalogued service (the scope-line wrap check)
 *   after a connect                the stored pending cards of that service flip to connected through the server's own
 *                                  markConnectionCardsConnected (kskill.ts) — a message event, 이어서 하기 on the newest,
 *                                  exactly as a real connect does (no turn is ever waiting here)
 *
 * Opened values are checked and dropped at once: never stored, never logged. Bogus values only. Messenger providers
 * and every other route go to the real app. QA_REAL=1: the app serves k-skill providers itself → no stand-ins.
 *
 *   PICKLE_DATA_DIR=<scratch> PORT=8916 PICKLE_AUDIO_PORT=8918 bun run apps/mobile/qa/skill-accounts-server.ts
 * Never point this at the preview server's data dir; never use 8787/5173/8789.
 */
import type { AgentEvent, Card, Connection, EnclaveEnvelope, ProviderInfo, SaveCredentialRequest } from "@pickle/protocol";
import type { LlmMessage, RunTurn } from "@pickle/agent";
import { buildDeps } from "../../server/src/main.ts";
import { createApp } from "../../server/src/app.ts";
import { markConnectionCardsConnected } from "../../server/src/kskill.ts";

const PORT = Number(process.env.PORT ?? 8916);
const TAKEN = [8787, 5173, 8781, 8782, 8789, 8794, 8795, 8810];
if (TAKEN.includes(PORT)) throw new Error(`${PORT} belongs to someone else — pick another port`);
if (!process.env.PICKLE_DATA_DIR) throw new Error("set PICKLE_DATA_DIR to a scratch directory");
if (!process.env.PICKLE_AUDIO_PORT || TAKEN.includes(Number(process.env.PICKLE_AUDIO_PORT))) throw new Error("set PICKLE_AUDIO_PORT to a free port of your own (the default is the live 8789)");
const REAL = process.env.QA_REAL === "1";

const env = { ...process.env, OPENGATEWAY_API_KEY: "", OPENGATEWAY_BASE_URL: "", PICKLE_TTS_URL: "off", PICKLE_AUDIO_TUNNEL: "0", MEET_BOT_URL: "off", STT_URL: "off", TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "", TWILIO_FROM: "" };
const built = await buildDeps(env);
const deps = built.deps as typeof built.deps & { enclave: { openEnvelope(env: EnclaveEnvelope, aad: string): Promise<Record<string, string>> } };

// ── synthetic k-skill catalog (field keys as a server would send them; the app draws whatever it gets) ──
const pw = (key: string, label: string, extra: Record<string, unknown> = {}) => ({ key, label, type: "password" as const, autocomplete: "off", ...extra });
const tx = (key: string, label: string, extra: Record<string, unknown> = {}) => ({ key, label, type: "text" as const, autocomplete: "off", ...extra });
// as the server lists them (KSKILL-CONNECTIONS + kskill-tools' connectionServices()): API-key services are auth "api_key",
// kind "token"; ids are vault service ids; fields copied from packages/skills/src/connected/*.ts
const svc = (id: string, name: string, kind: "login" | "token", fields: ProviderInfo["fields"], extra: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id,
  name,
  category: "korea",
  icon: "key",
  hue: 0,
  auth: kind === "token" ? "api_key" : "credentials",
  kind,
  fields,
  description: `${name} 계정으로 조회해요.`,
  capabilities: ["read"],
  available: true,
  ...extra,
});
const KOREA: ProviderInfo[] = REAL
  ? []
  : [
      svc("toss-investment", "토스증권", "token", [tx("clientId", "Client ID", { placeholder: "Open API 콘솔의 client_id" }), pw("clientSecret", "Client Secret", { hint: "조회에만 써요." })]),
      svc("foresttrip-vacancy", "숲나들e", "login", [tx("id", "아이디"), pw("password", "비밀번호")]), // parked: hidden by the app
      svc("naver-searchad", "네이버 검색광고", "token", [
        tx("apiKey", "API 키 (액세스 라이선스)", { placeholder: "검색광고 > 도구 > API 사용 관리" }),
        pw("secretKey", "비밀키"),
        tx("customerId", "고객 ID (CUSTOMER_ID)", { placeholder: "숫자", hint: "조회에만 써요." }),
      ]),
      svc("popbill", "팝빌", "token", [
        tx("linkId", "LinkID", { placeholder: "팝빌 연동 신청 때 받은 LinkID" }),
        pw("secretKey", "SecretKey"),
        tx("corpNum", "사업자번호", { placeholder: "연동회원 사업자번호 10자리" }),
        tx("userId", "팝빌 아이디", { optional: true, placeholder: "팝빌 사이트 로그인 아이디" }),
        tx("env", "환경", { optional: true, placeholder: "테스트 또는 운영", hint: "비워 두면 ‘테스트’예요. ‘운영’이면 국세청에 실제로 전송돼요." }),
      ], { capabilities: ["read", "send"] }),
      svc("coupang-partners", "쿠팡 파트너스", "token", [tx("accessKey", "Access Key", { placeholder: "추가기능 > Open API" }), pw("secretKey", "Secret Key", { hint: "상품 검색에만 써요." })]),
      svc("korean-jangbu-for", "CODEF", "token", [tx("clientId", "Client ID"), pw("clientSecret", "Client Secret")]),
      svc("riss", "RISS", "token", [pw("apiKey", "RISS 검색 API 키", { hint: "RISS API 센터에서 기관 승인 후 받은 키예요." })]),
      // never listed by the app: 헤이유미 while not enabled (here), and CODEF and 숲나들e, which are parked (above)
      svc("heyyumi", "헤이유미", "login", [], { available: false, unavailableReason: "곧 연결돼요" }),
    ];
// the developer keys (KSKILL-LOGIN-BRIEF C): no tool lists them yet; /qa/skill/extras adds them for one account so the
// folded "키로 연결" group is still tested, with one the server can't connect right now
const EXTRA: ProviderInfo[] = REAL
  ? []
  : [
      svc("building-register-search", "건축물대장", "token", [pw("apiKey", "공공데이터포털 인증키")]),
      svc("korean-patent-search", "특허 검색", "token", [pw("apiKey", "KIPRIS Plus API 키")]),
      svc("lck-analytics", "LCK 경기 기록", "token", [pw("apiKey", "LoL Esports API 키")]),
      svc("government-bond-analysis", "국채 금리 분석", "token", [pw("apiKey", "ECOS 인증키")], { available: false, unavailableReason: "점검 중이에요" }),
    ];
const extras = new Set<string>(); // userIds that asked for EXTRA
const bare = new Set<string>(); // userIds that see the real answer only
const BY_ID = new Map([...KOREA, ...EXTRA].map((p) => [p.id, p]));
const rows = new Map<string, Map<string, Connection>>(); // userId → service → row
const mine = (u: string) => {
  let m = rows.get(u);
  if (!m) rows.set(u, (m = new Map()));
  return m;
};

// ── stand-in for the LLM: any message → a pending connection_request card for 토스증권 ──
// every catalogued service but the parked ones: what "문장 확인" posts a pending card for
const LINE_IDS = ["toss-investment", "heyyumi", "naver-searchad", "popbill", "coupang-partners", "riss", "building-register-search", "korean-patent-search", "lck-analytics", "government-bond-analysis"];
const pendingCard = (service: string, name: string, reason: string) =>
  ({ type: "connection_request", service, serviceName: name, title: `${name} 연결이 필요해요`, reason, status: "pending", action: { label: "연결하기", open: "connections" } }) as unknown as Card;
const standIn: RunTurn = async (input, emit) => {
  const said = input.userText ?? "";
  let cards: Card[] = [];
  let text: string;
  if (/연결했어요/.test(said)) {
    // 이어서 하기 from a flipped card: the turn carries on (the card itself was flipped by the server, not here)
    text = "좋아요, 이어서 볼게요.";
  } else if (/문장 확인/.test(said)) {
    cards = LINE_IDS.map((id) => {
      const name = BY_ID.get(id)?.name ?? id;
      return pendingCard(id, name, `${name} 연결이 필요해요`);
    });
    text = "연결이 필요한 서비스예요.";
  } else {
    cards = [pendingCard("toss-investment", "토스증권", "보유 주식을 보려면 토스증권 연결이 필요해요")]; // the real tool's line (packages/skills connected/toss.ts)
    text = "토스증권을 연결하면 바로 이어서 볼게요.";
  }
  for (const card of cards) emit({ type: "card", card } as AgentEvent);
  emit({ type: "text", delta: text });
  const messages: LlmMessage[] = [{ role: "assistant", content: text }];
  return { text, cards, tools: [], messages, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
};
if (!REAL) deps.runTurn = standIn;

const app = createApp(deps);
built.bindApp(app);
app.start();

async function whoami(req: Request, srv: unknown): Promise<string | null> {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const r = await app.fetch(new Request(`http://127.0.0.1:${PORT}/api/session`, { headers: { authorization: auth } }), srv as never);
  if (!r.ok) return null;
  return ((await r.json()) as { user?: { id?: string } }).user?.id ?? null;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = (provider: string, patch: Partial<Connection>): Connection => ({ provider, status: "disconnected", accountLabel: null, credentialId: null, lastError: null, connectedAt: null, updatedAt: Date.now(), ...patch });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const m = /^\/api\/connections(?:\/([^/]+))?$/.exec(url.pathname);
    const id = m?.[1] ? decodeURIComponent(m[1]) : null;
    if (REAL || !(url.pathname === "/qa/skill/seed" || url.pathname === "/qa/skill/extras" || url.pathname === "/qa/skill/bare" || (m && (!id ? req.method === "GET" : BY_ID.has(id))))) return app.fetch(req, srv as never);
    const userId = await whoami(req, srv);
    if (!userId) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/qa/skill/seed") {
      const b = (await req.json()) as Partial<Connection> & { service: string };
      mine(userId).set(b.service, row(b.service, { connectedAt: Date.now() - 3 * 86_400_000, credentialId: "qa-cred-seed", ...b }));
      return json({ ok: true });
    }
    if (url.pathname === "/qa/skill/bare") {
      if (((await req.json()) as { on?: boolean }).on) bare.add(userId);
      else bare.delete(userId);
      return json({ ok: true });
    }
    if (bare.has(userId)) return app.fetch(req, srv as never);
    if (url.pathname === "/qa/skill/extras") {
      if (((await req.json()) as { on?: boolean }).on) extras.add(userId);
      else extras.delete(userId);
      return json({ ok: true });
    }
    if (!id) {
      const real = (await (await app.fetch(req, srv as never)).json()) as { providers?: ProviderInfo[]; connections?: Connection[] };
      // the stand-ins replace any k-skill service the app already lists itself (same ids), so nothing shows twice
      const ours = (id: string) => BY_ID.has(id);
      return json({
        providers: [...(real.providers ?? []).filter((p) => !ours(p.id)), ...KOREA, ...(extras.has(userId) ? EXTRA : [])],
        connections: [...(real.connections ?? []).filter((c) => !ours(c.provider)), ...mine(userId).values()],
      });
    }
    const p = BY_ID.get(id)!;
    if (req.method === "POST") {
      const c = ((await req.json().catch(() => null)) as { credential?: SaveCredentialRequest } | null)?.credential;
      if (!c?.envelope || c.service !== id) return json({ error: "invalid_envelope" }, 400);
      const kind = p.kind ?? (p.auth === "token" || p.auth === "api_key" ? "token" : "login");
      let refused = false;
      let unreachable = false;
      try {
        const fields = await deps.enclave.openEnvelope(c.envelope, `${userId}:${id}:${kind}`);
        refused = Object.values(fields).some((v) => v === "qa-refused");
        unreachable = Object.values(fields).some((v) => v === "qa-unreachable");
      } catch {
        return json({ error: "invalid_envelope" }, 400);
      }
      await new Promise((r) => setTimeout(r, 450)); // an upstream verify takes a moment
      if (refused) return json({ connection: row(id, { status: "error", lastError: `${p.name}가 키를 받지 않았어요. 발급한 값을 다시 확인해 주세요.` }) });
      if (unreachable) {
        // messenger-login's server: the credential is kept and re-checked at 30 s, 2 min and 10 min (events not stood in)
        const waiting = row(id, { status: "needs_verification", accountLabel: c.hint || null, credentialId: `qa-cred-${crypto.randomUUID().slice(0, 8)}`, lastError: `지금은 ${p.name}에 확인하지 못했어요. 저장해 두었고 잠시 후 다시 확인할게요.` });
        mine(userId).set(id, waiting);
        return json({ connection: waiting });
      }
      // a key-only service sends no hint; the real verify names the key instead (kskill-tools: "RISS 검색 API")
      const conn = row(id, { status: "connected", accountLabel: c.hint || (id === "riss" ? "RISS 검색 API" : null), credentialId: `qa-cred-${crypto.randomUUID().slice(0, 8)}`, connectedAt: Date.now() });
      mine(userId).set(id, conn);
      markConnectionCardsConnected(app.core, userId, id, { woke: 0, live: 0 });
      return json({ connection: conn });
    }
    if (req.method === "DELETE") {
      await new Promise((r) => setTimeout(r, 300));
      mine(userId).delete(id);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  },
});
console.log(JSON.stringify({ qa: "skill-accounts-server", url: `http://${server.hostname}:${server.port}`, real: REAL, pid: process.pid }));

const stop = async () => {
  server.stop();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
