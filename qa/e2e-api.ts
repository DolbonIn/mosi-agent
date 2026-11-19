/**
 * Live end-to-end API scenario against a running server (real LLM, real k-skill proxy).
 *   PICKLE_URL=http://127.0.0.1:8787 bun qa/e2e-api.ts
 * Prints a step table; exits 1 on the first hard failure. Never prints secrets.
 */
import type {
  AgentEvent, AuthResponse, ConnectionsResponse, CredentialInfo, EnclaveInfo, ExploreResponse, Friend,
  InviteResponse, Message, ProfileResponse, Schedule, SessionBootstrap, Thread, UiDefinitions,
} from "@pickle/protocol";
import { sealForEnclave } from "@pickle/vault/client";

const BASE = (process.env.PICKLE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const rows: { step: string; ok: boolean; ms: number; note: string }[] = [];

async function step<T>(name: string, fn: () => Promise<{ value: T; note?: string }>, hard = true): Promise<T | undefined> {
  const t0 = performance.now();
  try {
    const { value, note } = await fn();
    rows.push({ step: name, ok: true, ms: Math.round(performance.now() - t0), note: note ?? "" });
    return value;
  } catch (err) {
    rows.push({ step: name, ok: false, ms: Math.round(performance.now() - t0), note: String((err as Error).message).slice(0, 160) });
    if (hard) finish(1);
    return undefined;
  }
}

function finish(code: number): never {
  console.table(rows);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`${rows.length - failed}/${rows.length} steps ok`);
  process.exit(code || (failed ? 1 : 0));
}

async function api<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 120)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function stream(token: string, path: string, body: unknown): Promise<AgentEvent[]> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`${path} → ${res.status} ${(await res.text()).slice(0, 120)}`);
  const events: AgentEvent[] = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        const m = /^data:\s?(.*)$/.exec(line);
        if (m?.[1]) events.push(JSON.parse(m[1]) as AgentEvent);
      }
    }
  }
  return events;
}

const doneMsg = (ev: AgentEvent[]): Message => {
  const d = ev.find((e) => e.type === "done");
  if (!d || d.type !== "done") {
    const err = ev.find((e) => e.type === "error");
    throw new Error(err && err.type === "error" ? `${err.error}: ${err.message}` : "no done event");
  }
  return d.message;
};

// fake device signing key (WebCrypto) so approvals can be device-verified
const deviceKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const deviceJwk = await crypto.subtle.exportKey("jwk", deviceKeys.publicKey);
const device = { id: `qa-${crypto.randomUUID().slice(0, 8)}`, label: "QA script", signingKey: deviceJwk };
const b64url = (b: ArrayBuffer) => Buffer.from(b).toString("base64url");

const handle = `qa_${Date.now().toString(36)}`;
const password = `pw-${crypto.randomUUID()}`;

await step("health", async () => {
  const h = await api<{ ok: boolean; llm: string; model: string }>(null, "GET", "/api/health");
  if (!h.ok || h.llm !== "configured") throw new Error(`llm=${h.llm}`);
  return { value: h, note: h.model };
});

const auth = await step("signup", async () => {
  const r = await api<AuthResponse>(null, "POST", "/api/auth/signup", { handle, password, displayName: "큐에이", agentName: "깽이", device });
  return { value: r, note: `agent=${r.session.agent.name}` };
});
const token = auth!.token;

await step("login (wrong password rejected)", async () => {
  try {
    await api(null, "POST", "/api/auth/login", { handle, password: "nope-nope", device });
  } catch {
    return { value: true };
  }
  throw new Error("wrong password accepted");
});

const session = await step("session bootstrap", async () => {
  const s = await api<SessionBootstrap>(token, "GET", "/api/session");
  return { value: s, note: `quota ${s.quota.usedPct}% tickets ${s.tickets.basic}/${s.tickets.premium}` };
});

await step("ui-definitions", async () => {
  const u = await api<UiDefinitions>(token, "GET", "/api/ui-definitions");
  if (u.tabs.length !== 4) throw new Error("tabs != 4");
  return { value: u, note: u.tabs.map((t) => t.title).join("/") };
});

const main = session!.mainThreadId;
await step("welcome message seeded", async () => {
  const r = await api<Message[]>(token, "GET", `/api/threads/${main}/messages`);
  if (!r.length) throw new Error("no welcome");
  return { value: r, note: `${r.length} msg, cards=${r[0]!.cards.map((c) => c.type).join(",")}` };
});

await step("chat: weather via k-skill (live LLM + proxy)", async () => {
  const ev = await stream(token, `/api/threads/${main}/messages`, { text: "지금 강남역 날씨 어때?" });
  const m = doneMsg(ev);
  const tools = m.tools.map((t) => `${t.name}:${t.state}`);
  if (!m.tools.some((t) => t.name === "k_weather")) throw new Error(`no k_weather; tools=${tools} text=${m.text.slice(0, 80)}`);
  return { value: m, note: `${tools.join(" ")} | ${m.text.slice(0, 50)}…` };
});

await step("chat: news + subway in one turn (parallel tools)", async () => {
  const ev = await stream(token, `/api/threads/${main}/messages`, { text: "오늘 AI 뉴스 3개랑 강남역 지하철 도착 정보 같이 알려줘" });
  const m = doneMsg(ev);
  return { value: m, note: m.tools.map((t) => `${t.name}:${t.state}`).join(" ") };
}, false);

await step("chat: artifact document", async () => {
  const ev = await stream(token, `/api/threads/${main}/messages`, { text: "제주 2박 3일 일정을 문서로 만들어서 보관함에 저장해줘. 짧게." });
  const m = doneMsg(ev);
  const card = m.cards.find((c) => c.type === "artifact");
  if (!card) throw new Error(`no artifact card; tools=${m.tools.map((t) => t.name)}`);
  return { value: m, note: card.type === "artifact" ? card.title : "" };
}, false);

await step("chat: schedule (모닝콜)", async () => {
  const ev = await stream(token, `/api/threads/${main}/messages`, { text: "매일 아침 7시 30분에 오늘 날씨랑 일정 브리핑 해줘" });
  const m = doneMsg(ev);
  const s = await api<Schedule[]>(token, "GET", "/api/schedules");
  if (!s.length) throw new Error(`no schedule; tools=${m.tools.map((t) => t.name)}`);
  return { value: s, note: s.map((x) => x.human).join(", ") };
}, false);

await step("stop: aborted turn is not answered by the next turn", async () => {
  // a fresh thread so earlier steps can't leak into the reply
  const t = await api<Thread>(token, "POST", "/api/threads", { title: "멈춤 테스트" });
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/threads/${t.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: "피보나치 수열 30번째 값 계산해줘" }),
    signal: ac.signal,
  });
  if (res.status !== 200 || !res.body) throw new Error(`stopped request → ${res.status}`);
  // Stop as the app does: close the stream right after the first event
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let first = "";
  while (!first.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    first += dec.decode(value, { stream: true });
  }
  ac.abort();
  await reader.cancel().catch(() => {});

  // the very next message, sent right away
  const ev = await stream(token, `/api/threads/${t.id}/messages`, { text: "고마워" });
  const m = doneMsg(ev);
  const said = m.text.replace(/[,\s]/g, "");
  if (said.includes("832040")) throw new Error(`the stopped request was answered: ${m.text.slice(0, 80)}`);
  const msgs = await api<Message[]>(token, "GET", `/api/threads/${t.id}/messages`);
  if (msgs.some((x) => x.role === "assistant" && x.text.replace(/[,\s]/g, "").includes("832040"))) throw new Error("a stored answer has 832040");
  return { value: m, note: `${msgs.length} msgs | 고마워 → ${m.text.replace(/\s+/g, " ").slice(0, 50)}` };
});

const enclave = await step("enclave info", async () => {
  const e = await api<EnclaveInfo>(token, "GET", "/api/enclave");
  return { value: e, note: `kid=${e.kid} measurement=${e.measurement.slice(0, 12)}…` };
});

const cred = await step("save login (device-sealed envelope)", async () => {
  const userId = session!.user.id;
  const envelope = await sealForEnclave(enclave!, { username: "qa@example.com", password: "not-a-real-password" }, `${userId}:naver:login`);
  const c = await api<CredentialInfo>(token, "POST", "/api/credentials", {
    service: "naver", label: "네이버 (qa@…)", kind: "login", hint: "qa***@example.com", keepFor: "1d", envelope,
  });
  if (JSON.stringify(c).includes("not-a-real-password")) throw new Error("secret leaked in response");
  return { value: c, note: `${c.label} expires ${c.expiresAt ? new Date(c.expiresAt).toISOString() : "never"}` };
});

await step("tampered envelope rejected", async () => {
  const userId = session!.user.id;
  const envelope = await sealForEnclave(enclave!, { username: "x", password: "y" }, `${userId}:naver:login`);
  envelope.aad = `someone-else:naver:login`;
  try {
    await api(token, "POST", "/api/credentials", { service: "naver", label: "x", kind: "login", hint: "x", keepFor: "1h", envelope });
  } catch {
    return { value: true };
  }
  throw new Error("tampered envelope accepted");
});

await step("credentials list + access log", async () => {
  const list = await api<CredentialInfo[]>(token, "GET", "/api/credentials");
  const log = await api<unknown[]>(token, "GET", "/api/access-log");
  if (!list.some((c) => c.id === cred!.id)) throw new Error("credential missing");
  return { value: list, note: `${list.length} creds, ${log.length} access records` };
});

await step("connections catalog", async () => {
  const c = await api<ConnectionsResponse>(token, "GET", "/api/connections");
  const ids = c.providers.map((p) => `${p.id}${p.available ? "" : "(n/a)"}`);
  if (!ids.some((i) => i.startsWith("kakaotalk"))) throw new Error("kakaotalk provider missing");
  return { value: c, note: ids.join(" ") };
});

await step("kakaotalk connect with bogus creds → error status (no crash)", async () => {
  const userId = session!.user.id;
  const envelope = await sealForEnclave(enclave!, { email: "qa-not-real@example.com", password: "wrong-password-123" }, `${userId}:kakaotalk:login`);
  const r = await fetch(`${BASE}/api/connections/kakaotalk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ credential: { service: "kakaotalk", label: "카카오톡 (qa)", kind: "login", hint: "qa***", keepFor: "1h", envelope } }),
  });
  const body = await r.text();
  if (body.includes("wrong-password-123")) throw new Error("secret leaked");
  return { value: r.status, note: `${r.status} ${body.slice(0, 90)}` };
}, false);

await step("approval flow: msg_send asks first", async () => {
  const ev = await stream(token, `/api/threads/${main}/messages`, { text: "카카오톡 '가족' 방에 '오늘 늦어요' 라고 보내줘" });
  const m = doneMsg(ev);
  const kinds = m.cards.map((c) => c.type);
  return { value: m, note: `cards=${kinds.join(",")} tools=${m.tools.map((t) => `${t.name}:${t.state}`).join(" ")}` };
}, false);

await step("approval: outbound call asks first, device-signed approve resumes the turn", async () => {
  const ev = await stream(token, `/api/threads/${main}/messages`, { text: "010-1234-5678로 전화해서 내일 저녁 7시에 2명 예약 되는지 물어봐줘" });
  const m = doneMsg(ev);
  const card = m.cards.find((c) => c.type === "approval");
  if (!card || card.type !== "approval" || card.status !== "pending") throw new Error(`no pending approval card (cards=${m.cards.map((c) => c.type).join(",")})`);
  const nonce = crypto.randomUUID();
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, deviceKeys.privateKey, new TextEncoder().encode(`approve:${card.approvalId}:${nonce}`));
  const ev2 = await stream(token, `/api/approvals/${card.approvalId}`, { decision: "approve", signature: b64url(sig), nonce, deviceId: device.id });
  const m2 = doneMsg(ev2);
  const replay = await fetch(`${BASE}/api/approvals/${card.approvalId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve", signature: b64url(sig), nonce, deviceId: device.id }),
  });
  if (replay.ok && (await replay.text()).includes("\"done\"")) throw new Error("approval replay was accepted");
  const log = await api<{ action: string; deviceVerified?: boolean }[]>(token, "GET", "/api/access-log");
  return { value: m2, note: `${card.title.slice(0, 30)} → ${m2.tools.map((t) => `${t.name}:${t.state}`).join(" ")} | replay ${replay.status} | log=${log.length}` };
});

await step("explore + delegate", async () => {
  const e = await api<ExploreResponse>(token, "GET", "/api/explore");
  const tpl = e.popular.find((t) => t.id !== "call-demo") ?? e.popular[0]!;
  const d = await api<{ thread: Thread; prompt: string }>(token, "POST", `/api/explore/${tpl.id}/delegate`);
  return { value: d, note: `${e.categories.length} cats, ${e.popular.length} popular → ${d.thread.title}` };
});

await step("profile", async () => {
  const p = await api<ProfileResponse>(token, "GET", "/api/profile");
  return { value: p, note: `used ${p.quota.usedTokens} tok (${p.quota.usedPct}%), usage7d=${p.usage7d.length}, logins=${p.savedLogins}` };
});

await step("friends: invite + accept by second user + shared thread", async () => {
  const inv = await api<InviteResponse>(token, "POST", "/api/invites");
  const k2 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const dev2 = { id: `qa2-${crypto.randomUUID().slice(0, 8)}`, label: "QA 2", signingKey: await crypto.subtle.exportKey("jwk", k2.publicKey) };
  const a2 = await api<AuthResponse>(null, "POST", "/api/auth/signup", { handle: `${handle}_b`, password, displayName: "친구", agentName: "콩이", device: dev2 });
  const f = await api<Friend>(a2.token, "POST", `/api/invites/${inv.token}/accept`);
  const mine = await api<Friend[]>(token, "GET", "/api/friends");
  if (!mine.some((x) => x.status === "accepted")) throw new Error("not accepted");
  return { value: f, note: `${f.displayName} thread=${f.threadId ? "yes" : "no"}` };
}, false);

await step("approval signing round-trip (if an approval exists)", async () => {
  const r = await api<Message[]>(token, "GET", `/api/threads/${main}/messages`);
  const card = r.flatMap((m) => m.cards).find((c) => c.type === "approval" && c.status === "pending");
  if (!card || card.type !== "approval") return { value: null, note: "no pending approval (skipped)" };
  const nonce = crypto.randomUUID();
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, deviceKeys.privateKey, new TextEncoder().encode(`approve:${card.approvalId}:${nonce}`));
  const ev = await stream(token, `/api/approvals/${card.approvalId}`, { decision: "reject", signature: b64url(sig), nonce, deviceId: device.id });
  const m = doneMsg(ev);
  return { value: m, note: `rejected → ${m.text.slice(0, 50)}` };
}, false);

finish(0);
