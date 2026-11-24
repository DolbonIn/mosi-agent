/**
 * Test harness: a real createApp() over a temp SQLite DB with small in-file fakes for every
 * package (launcher, vault, enclave, messenger hub, skills, runTurn) so the server tests never
 * depend on package progress.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccessRecord,
  AgentEvent,
  AgentPatch,
  AgentProfile,
  AgentStatus,
  AuthResponse,
  Connection,
  CredentialInfo,
  ProviderInfo,
  ServerEvent,
  SkillInfo,
} from "@pickle/protocol";
import type { CredentialAccess, RunTurn, ToolDef, TurnInput, TurnOutcome } from "@pickle/agent";
import { applyAgentPatch, nextRev, sameAgentFields } from "@pickle/launcher";
import { createApp, type App } from "../src/app.ts";
import { openDatabase, type Db, type CredentialRow } from "../src/db/index.ts";
import type { AppDeps, HubLike, LauncherLike, LeaseLike, ServerConfig, VaultLike } from "../src/deps.ts";
import type { ServerLike } from "../src/http.ts";

// ───────────────────────────── fakes ─────────────────────────────

export class FakeLease implements LeaseLike {
  queue: string[] = [];
  released = false;
  constructor(private onRelease: () => void) {}
  release() {
    if (this.released) return;
    this.released = true;
    this.onRelease();
  }
  steer(t: string) {
    if (!this.released) this.queue.push(t);
  }
  drain() {
    const q = this.queue;
    this.queue = [];
    return q;
  }
  pending() {
    return this.released ? 0 : this.queue.length;
  }
}

export class FakeLauncher implements LauncherLike {
  profiles = new Map<string, AgentProfile>();
  memories = new Map<string, { id: string; text: string; createdAt: number }[]>();
  daily: { userId: string; user: string; assistant: string }[] = [];
  leases = new Map<string, FakeLease>();
  waiters = new Map<string, ((l: FakeLease) => void)[]>();
  statuses = new Map<string, AgentStatus>();
  prompts: { userId: string; ctx: Parameters<LauncherLike["systemPrompt"]>[1] }[] = [];
  recallResult: string[] = ["사용자는 강남역 근처에서 일해요"];

  async provision(userId: string, init: { agentName: string; displayName: string }): Promise<AgentProfile> {
    const existing = this.profiles.get(userId);
    if (existing) return existing;
    const p: AgentProfile = {
      id: userId,
      name: init.agentName,
      persona: "",
      avatar: { hue: 8, shape: "blob", eyes: "dot" },
      model: "fake-model",
      status: "idle",
      enabledSkills: [],
      createdAt: Date.now(),
      lastActiveAt: null,
      rev: nextRev(0),
    };
    this.profiles.set(userId, p);
    return p;
  }
  async profile(userId: string) {
    return this.profiles.get(userId) ?? null;
  }
  /** the real launcher's merge (applyAgentPatch) and rev rule; one synchronous step, so patches never interleave */
  async update(userId: string, patch: AgentPatch, opts: { allSkills?: readonly string[] } = {}) {
    const cur = this.profiles.get(userId);
    if (!cur) throw new Error("agent not provisioned");
    const next = applyAgentPatch(cur, patch, opts.allSkills);
    const changed = !sameAgentFields(cur, next);
    const p: AgentProfile = changed ? { ...cur, ...next, rev: nextRev(cur.rev) } : cur;
    this.profiles.set(userId, p);
    return { profile: p, changed };
  }
  workspaceDir(userId: string) {
    return `/tmp/fake-agents/${userId}`;
  }
  async systemPrompt(userId: string, ctx: Parameters<LauncherLike["systemPrompt"]>[1]) {
    this.prompts.push({ userId, ctx });
    return `SYSTEM for ${ctx.displayName}`;
  }
  async appendDaily(userId: string, e: { user: string; assistant: string }) {
    this.daily.push({ userId, user: e.user, assistant: e.assistant });
  }
  async remember(userId: string, text: string) {
    const list = this.memories.get(userId) ?? [];
    const m = { id: `mem${list.length + 1}`, text, createdAt: Date.now() };
    list.push(m);
    this.memories.set(userId, list);
    return { id: m.id };
  }
  async recall() {
    return this.recallResult;
  }
  async listMemories(userId: string) {
    return this.memories.get(userId) ?? [];
  }
  async forget(userId: string, id: string) {
    const list = this.memories.get(userId) ?? [];
    const next = list.filter((m) => m.id !== id);
    this.memories.set(userId, next);
    return next.length !== list.length;
  }
  private grant(userId: string): FakeLease {
    const lease = new FakeLease(() => {
      this.leases.delete(userId);
      const w = this.waiters.get(userId)?.shift();
      if (w) w(this.grant(userId));
    });
    this.leases.set(userId, lease);
    return lease;
  }
  async acquire(userId: string): Promise<LeaseLike> {
    if (!this.leases.has(userId)) return this.grant(userId);
    return new Promise((res) => {
      const list = this.waiters.get(userId) ?? [];
      list.push(res);
      this.waiters.set(userId, list);
    });
  }
  tryAcquire(userId: string) {
    if (this.leases.has(userId)) return null;
    return this.grant(userId);
  }
  steer(userId: string, text: string) {
    const l = this.leases.get(userId);
    if (!l) return false;
    l.steer(text);
    return true;
  }
  status(userId: string): AgentStatus {
    return this.statuses.get(userId) ?? "idle";
  }
  setStatus(userId: string, s: AgentStatus) {
    this.statuses.set(userId, s);
  }
  async restart() {}
}

export function makeFakeVault(db: Db): VaultLike & { uses: string[] } {
  const storage = db.vaultStorage();
  let n = 0;
  const info = (r: CredentialRow): CredentialInfo => ({
    id: r.id,
    service: r.service,
    serviceName: r.service === "kakaotalk" ? "카카오톡" : r.service,
    label: r.label,
    kind: r.kind,
    hint: r.hint,
    keepFor: r.keepFor,
    expiresAt: r.expiresAt,
    expired: r.expiresAt !== null && r.expiresAt < Date.now(),
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    useCount: r.useCount,
  });
  const record = async (userId: string, rec: Omit<AccessRecord, "id" | "createdAt">) => {
    await storage.insertAccess(userId, { ...rec, id: `acc${++n}`, createdAt: Date.now() + n });
  };
  return {
    uses: [],
    async save(userId, req) {
      if (req.envelope.aad !== `${userId}:${req.service}:${req.kind}`) throw new Error("aad mismatch");
      const row: CredentialRow = {
        id: `cred${++n}`,
        userId,
        service: req.service,
        label: req.label,
        kind: req.kind,
        hint: req.hint,
        keepFor: req.keepFor,
        expiresAt: req.keepFor === "forever" ? null : Date.now() + 3_600_000,
        sealed: "sealed-not-plaintext",
        createdAt: Date.now(),
        lastUsedAt: null,
        useCount: 0,
      };
      await storage.insertCredential(row);
      return info(row);
    },
    async list(userId) {
      return (await storage.listCredentials(userId)).map(info);
    },
    async renew(userId, id, keepFor) {
      const row = await storage.getCredential(userId, id);
      if (!row) throw new Error("not found");
      await storage.updateCredential(userId, id, { keepFor, expiresAt: keepFor === "forever" ? null : Date.now() + 86_400_000 });
      return info((await storage.getCredential(userId, id))!);
    },
    async remove(userId, id) {
      return storage.deleteCredential(userId, id);
    },
    access(userId): CredentialAccess {
      const self = this;
      return {
        async find(service) {
          const rows = await storage.listCredentials(userId);
          const r = rows.find((x) => x.service === service);
          return r ? { id: r.id, hint: r.hint } : null;
        },
        async use(id, purpose, fn) {
          self.uses.push(id);
          await record(userId, { credentialId: id, service: "x", serviceName: "x", action: purpose.action, purpose: purpose.purpose, actor: "agent", outcome: "ok", deviceVerified: false });
          return fn({ username: "u" });
        },
      };
    },
    record,
    async accessLog(userId, limit = 50) {
      return storage.listAccess(userId, limit);
    },
  };
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "kakaotalk",
    name: "카카오톡",
    category: "messenger",
    icon: "kakao",
    hue: 50,
    auth: "credentials",
    fields: [{ key: "username", label: "이메일", type: "email" }],
    description: "카카오톡",
    capabilities: ["read", "send", "list"],
    available: true,
  },
  {
    id: "slack",
    name: "Slack",
    category: "messenger",
    icon: "slack",
    hue: 280,
    auth: "token",
    fields: [{ key: "token", label: "토큰", type: "password" }],
    description: "Slack",
    capabilities: ["read", "send", "list"],
    available: true,
  },
];

export function makeFakeHub(db: Db, onConnect?: (userId: string, c: Connection) => void): HubLike {
  const storage = db.messengerStorage();
  return {
    async connect(userId, provider) {
      const c: Connection = { provider, status: "connected", accountLabel: "me@example.com", credentialId: null, lastError: null, connectedAt: Date.now(), updatedAt: Date.now() };
      await storage.upsertConnection(userId, c);
      onConnect?.(userId, c);
      return { connection: c };
    },
    async verify(userId, provider) {
      const c = (await storage.getConnection(userId, provider))!;
      return { connection: c };
    },
    async disconnect(userId, provider) {
      await storage.deleteConnection(userId, provider);
    },
    connections: (userId) => storage.listConnections(userId),
    async listChats() {
      return [{ id: "c1", name: "가족", kind: "group", unread: 3 }];
    },
    tools: () => [],
    async shutdown() {},
  };
}

export const SKILLS: SkillInfo[] = [
  { id: "k.weather", title: "날씨", description: "날씨", category: "생활", icon: "cloud", needsKey: false, configured: true, source: "NomaDamas/k-skill · weather" },
];

export const weatherTool: ToolDef = {
  name: "k_weather",
  description: "weather",
  parameters: { type: "object", properties: { city: { type: "string" } } },
  icon: "cloud",
  title: (a) => `${String(a.city ?? "서울")} 날씨 확인`,
  async run() {
    return { ok: true, summary: "서울 14°, 흐림" };
  },
};

/** ECDSA P-256 verification over `approve:<id>:<nonce>` (same contract as @pickle/vault). */
export async function webcryptoVerifyApproval(jwk: JsonWebKey, approvalId: string, nonce: string, sig: string): Promise<boolean> {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const bytes = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes, new TextEncoder().encode(`approve:${approvalId}:${nonce}`));
}

export interface TestDevice {
  id: string;
  label: string;
  signingKey: JsonWebKey;
  privateKey: CryptoKey;
  sign(data: string): Promise<string>;
}

export async function makeDevice(): Promise<TestDevice> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const signingKey: JsonWebKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  return {
    id: `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    label: "Test Safari",
    signingKey,
    privateKey: pair.privateKey,
    async sign(data) {
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(data));
      return Buffer.from(sig).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
  };
}

// ───────────────────────────── runTurn fakes ─────────────────────────────

export type TurnScript = (input: TurnInput, emit: (e: AgentEvent) => void) => Promise<TurnOutcome>;

export function outcome(text: string, extra: Partial<TurnOutcome> = {}): TurnOutcome {
  return {
    text,
    cards: [],
    tools: [],
    messages: [{ role: "assistant", content: text }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    ...extra,
  };
}

/** A runTurn whose behaviour can be swapped per test; records every input. */
export function scriptedRunTurn() {
  const inputs: TurnInput[] = [];
  let script: TurnScript = async (_input, emit) => {
    emit({ type: "text", delta: "네, " });
    emit({ type: "text", delta: "알겠어요." });
    return outcome("네, 알겠어요.");
  };
  const runTurn: RunTurn = (input, emit) => {
    inputs.push(input);
    return script(input, emit);
  };
  return {
    runTurn,
    inputs,
    set(s: TurnScript) {
      script = s;
    },
  };
}

// ───────────────────────────── harness ─────────────────────────────

/** 2026-11-11 (Wed) 12:00 KST */
export const T0 = Date.UTC(2026, 10, 11, 3, 0, 0);

export interface Harness {
  app: App;
  db: Db;
  dir: string;
  clock: { t: number; now(): number };
  launcher: FakeLauncher;
  vault: ReturnType<typeof makeFakeVault>;
  turns: ReturnType<typeof scriptedRunTurn>;
  memoriesExtracted: string[];
  req(method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; ip?: string; raw?: BodyInit; signal?: AbortSignal }): Promise<Response>;
  signup(handle: string, opts?: { displayName?: string; agentName?: string; ip?: string }): Promise<AuthResponse & { device: TestDevice }>;
  close(): Promise<void>;
}

export function fakeServer(ip = "127.0.0.1"): ServerLike {
  return { requestIP: () => ({ address: ip }), timeout: () => {} };
}

export async function makeHarness(
  opts: { config?: Partial<ServerConfig>; now?: number; llm?: boolean; deps?: (base: { db: Db; vault: ReturnType<typeof makeFakeVault> }) => Partial<AppDeps> } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pickle-server-test-"));
  const db = openDatabase(join(dir, "pickle.db"));
  const clock = {
    t: opts.now ?? T0,
    now() {
      return this.t;
    },
  };
  const launcher = new FakeLauncher();
  const vault = makeFakeVault(db);
  const turns = scriptedRunTurn();
  const memoriesExtracted: string[] = [];
  let appRef: App | null = null;
  const hub = makeFakeHub(db, (u, c) => appRef?.notifyConnection(u, c));
  const app = createApp({
    db,
    launcher,
    vault,
    enclave: {
      info: () => ({
        kid: "kid-test",
        publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        alg: "ECDH-P256+HKDF-SHA256+A256GCM",
        measurement: "0".repeat(64),
        createdAt: 1,
      }),
    },
    hub,
    providers: () => PROVIDERS,
    runTurn: turns.runTurn,
    llm:
      opts.llm === false
        ? null
        : {
            model: "fake-model",
            async extractMemories(i) {
              if (i.userText.includes("기억해")) {
                memoriesExtracted.push("사용자는 고양이를 키워요");
                return ["사용자는 고양이를 키워요"];
              }
              return [];
            },
            async titleFor() {
              return "자동 제목";
            },
          },
    skills: { listSkills: () => SKILLS, skillTools: () => [weatherTool], skillCatalogForPrompt: () => "- k_weather: 날씨 확인" },
    systemTools: () => [],
    verifyApproval: webcryptoVerifyApproval,
    clock,
    ...opts.deps?.({ db, vault }),
    config: {
      dataDir: dir,
      quiet: true,
      turnSettleMs: 50,
      passwordCost: { memoryCost: 4096, timeCost: 2 },
      sseHeartbeatMs: 0,
      eventsHeartbeatMs: 0,
      ...opts.config,
    },
  });
  appRef = app;

  const req: Harness["req"] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let body: BodyInit | undefined = o.raw;
    if (o.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(o.body);
    }
    return app.fetch(new Request(`http://localhost${path}`, { method, headers, body, signal: o.signal }), fakeServer(o.ip));
  };

  let ipCounter = 0;
  const signup: Harness["signup"] = async (handle, o = {}) => {
    const device = await makeDevice();
    const res = await req("POST", "/api/auth/signup", {
      ip: o.ip ?? `10.0.0.${++ipCounter}`,
      body: { handle, password: "correct horse battery", displayName: o.displayName ?? "하늘", agentName: o.agentName ?? "깽이", device },
    });
    if (res.status !== 201) throw new Error(`signup failed ${res.status} ${await res.text()}`);
    return { ...((await res.json()) as AuthResponse), device };
  };

  return {
    app,
    db,
    dir,
    clock,
    launcher,
    vault,
    turns,
    memoriesExtracted,
    req,
    signup,
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ───────────────────────────── SSE helpers ─────────────────────────────

export function parseSse(text: string): unknown[] {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n"))
    .filter(Boolean)
    .map((d) => JSON.parse(d));
}

export async function readSse(res: Response): Promise<AgentEvent[]> {
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  return parseSse(await res.text()) as AgentEvent[];
}

/** Incremental reader for an open SSE response (/api/events). */
export function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const queue: unknown[] = [];
  /** a read still waiting when `next` timed out: the next pull takes its chunk (a new read would leave that chunk to it, lost) */
  let pending: ReturnType<typeof reader.read> | null = null;
  async function pull(timeoutMs: number): Promise<boolean> {
    const t = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
    const read = (pending ??= reader.read());
    const r = await Promise.race([read, t]);
    if (r === "timeout") return false;
    pending = null;
    if (r.done) return false;
    buf += dec.decode(r.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) queue.push(JSON.parse(data));
    }
    return true;
  }
  return {
    /** next event matching `pred` (skips others), or null after timeout */
    async next<T = ServerEvent | AgentEvent>(pred: (e: any) => boolean, timeoutMs = 1000): Promise<T | null> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = queue.findIndex(pred);
        if (idx >= 0) return queue.splice(idx, 1)[0] as T;
        const left = deadline - Date.now();
        if (left <= 0) return null;
        if (!(await pull(left))) {
          const again = queue.findIndex(pred);
          return again >= 0 ? (queue.splice(again, 1)[0] as T) : null;
        }
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {});
    },
  };
}

import { expect } from "bun:test";
