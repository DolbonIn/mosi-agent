/**
 * Auth: handle + password (argon2id via Bun.password), opaque bearer tokens stored as sha256,
 * 90-day sessions, device key registration (ECDSA P-256 public JWK for approval signatures),
 * per-IP rate limiting on signup/login.
 */
import type { AuthResponse, Card, SessionBootstrap } from "@pickle/protocol";
import type { UserRow } from "./db/index.ts";
import { agentFor, quotaFor, settingsOf, userPublic, type Core } from "./core.ts";
import { bad, HttpError, json, readJson, str, type Ctx } from "./http.ts";
import { defaultSettings } from "./settings.ts";
import { ieyo, isRecord, newId, randomB64url, sha256Hex, timingSafeEqualStr } from "./util.ts";
import { errInfo } from "./log.ts";

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const LOGIN_FAILED = "아이디 또는 비밀번호가 맞지 않아요";

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number,
  ) {}

  /** true when allowed (and counts the hit) */
  hit(key: string): boolean {
    const now = this.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.sweep(now);
    return true;
  }

  retryAfter(key: string): number {
    const arr = this.hits.get(key) ?? [];
    if (!arr.length) return 1;
    return Math.max(1, Math.ceil((this.windowMs - (this.now() - arr[0]!)) / 1000));
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

export interface AuthedUser {
  userId: string;
  tokenHash: string;
  deviceId: string | null;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(h.trim());
  return m ? m[1]! : null;
}

/** Resolves the session for a request. `allowQuery` accepts `?token=` (EventSource / media tags). */
export function authenticate(core: Core, req: Request, url: URL, allowQuery: boolean): AuthedUser | null {
  let token = bearer(req);
  if (!token && allowQuery) {
    const q = url.searchParams.get("token");
    if (q && /^[A-Za-z0-9_-]{20,200}$/.test(q)) token = q;
  }
  if (!token) return null;
  const hash = sha256Hex(token);
  const s = core.db.sessionByHash(hash);
  if (!s || !timingSafeEqualStr(s.token_hash, hash)) return null;
  const now = core.now();
  if (s.expires_at <= now) {
    core.db.deleteSession(hash);
    return null;
  }
  if (now - s.last_seen_at > 60_000) core.db.touchSession(hash, now);
  return { userId: s.user_id, tokenHash: hash, deviceId: s.device_id };
}

interface DeviceInput {
  id: string;
  label: string;
  signingJwk: string;
}

export function parseDevice(v: unknown): DeviceInput {
  if (!isRecord(v)) throw bad("기기 정보가 필요해요", "invalid_device");
  const id = typeof v.id === "string" ? v.id.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw bad("기기 정보가 올바르지 않아요", "invalid_device");
  const label = typeof v.label === "string" ? v.label.trim().slice(0, 60) || "알 수 없는 기기" : "알 수 없는 기기";
  const k = v.signingKey;
  if (!isRecord(k) || k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string" || "d" in k)
    throw bad("기기 키가 올바르지 않아요", "invalid_device");
  const jwk = { kty: "EC", crv: "P-256", x: k.x, y: k.y };
  return { id, label, signingJwk: JSON.stringify(jwk) };
}

export async function hashPassword(core: Core, pw: string): Promise<string> {
  const cost = core.cfg.passwordCost;
  return Bun.password.hash(pw, { algorithm: "argon2id", ...(cost?.memoryCost ? { memoryCost: cost.memoryCost } : {}), ...(cost?.timeCost ? { timeCost: cost.timeCost } : {}) });
}

let dummyHash: Promise<string> | null = null;

export function issueSession(core: Core, userId: string, deviceId: string | null): string {
  const token = randomB64url(32);
  const now = core.now();
  core.db.createSession({ tokenHash: sha256Hex(token), userId, deviceId, now, expiresAt: now + SESSION_TTL_MS });
  return token;
}

export async function bootstrap(core: Core, user: UserRow): Promise<SessionBootstrap> {
  return {
    user: userPublic(user),
    agent: await agentFor(core, user),
    quota: quotaFor(core, user.id),
    tickets: core.db.tickets(user.id),
    settings: settingsOf(user),
    mainThreadId: user.main_thread_id ?? ensureMainThread(core, user),
    unreadThreads: core.db.unreadCount(user.id),
    server: { llm: core.deps.runTurn ? "configured" : "missing", model: core.deps.llm?.model ?? null, version: core.cfg.version },
  };
}

/** Creates the main thread + static welcome message (no LLM). */
export function ensureMainThread(core: Core, user: UserRow): string {
  if (user.main_thread_id && core.db.threadFor(user.main_thread_id, user.id)) return user.main_thread_id;
  const now = core.now();
  const threadId = newId("t");
  core.db.createThread({ id: threadId, ownerId: user.id, kind: "main", title: "기본 채팅", subtitle: "", icon: "chat", now }, [user.id]);
  core.db.setMainThread(user.id, threadId);
  const card: Card = {
    type: "briefing",
    title: "이런 일을 맡겨 보세요",
    items: [
      { icon: "sun", text: "오늘 날씨와 미세먼지를 알려 드려요", action: { label: "오늘 날씨 알려 줘", send: "오늘 날씨 알려 줘" } },
      { icon: "doc", text: "지금 신청할 수 있는 정부 지원사업을 찾아 드려요", action: { label: "지원사업 찾아줘", send: "내가 지금 신청할 수 있는 정부 지원사업 찾아줘" } },
      { icon: "kakao", text: "카카오톡을 연결하면 안 읽은 대화를 정리해 드려요", action: { label: "카카오톡 연결하기", open: "connections" } },
      { icon: "clock", text: "매일 아침 브리핑을 먼저 보내 드려요", action: { label: "모닝 브리핑 예약", send: "매일 아침 7시에 날씨랑 뉴스 브리핑해줘" } },
    ],
  };
  core.db.insertMessage({
    id: newId("m"),
    threadId,
    role: "assistant",
    text: `안녕하세요, ${user.display_name} 님. 저는 ${ieyo(user.agent_name)}.\n궁금한 걸 묻거나 귀찮은 일을 맡겨 주세요.`,
    cards: [card],
    llm: [{ role: "assistant", content: `안녕하세요, ${user.display_name} 님! 저는 ${ieyo(user.agent_name)}. 무엇을 도와드릴까요?` }],
    createdAt: now,
  });
  core.db.touchThread(threadId, now, "이런 일을 맡겨 보세요");
  return threadId;
}

/** Every installed skill: the launcher provisions with none unless told otherwise. */
export function defaultSkillIds(core: Core): string[] {
  try {
    return core.deps.skills.listSkills().map((s) => s.id);
  } catch {
    return [];
  }
}

export function authRoutes(core: Core) {
  const limiter = new RateLimiter(core.cfg.authRatePerMinute, 60_000, core.now);
  const limit = (c: Ctx) => {
    if (!limiter.hit(c.ip)) {
      const ra = limiter.retryAfter(c.ip);
      throw new HttpError(429, "rate_limited", "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.", { "Retry-After": String(ra) });
    }
  };

  return {
    signup: async (c: Ctx) => {
      limit(c);
      const body = await readJson(c.req);
      const handle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : "";
      if (!HANDLE_RE.test(handle)) throw bad("아이디는 영어 소문자, 숫자, _로 3~20자여야 해요", "invalid_handle");
      if (typeof body.password !== "string" || body.password.length < 8) throw bad("비밀번호는 8자 이상이어야 해요", "weak_password");
      if (body.password.length > 128) throw bad("비밀번호가 너무 길어요", "invalid_password");
      const displayName = str(body.displayName, "이름", { max: 20 });
      const agentName = str(body.agentName, "모시 이름", { max: 12 });
      if (/[\u0000-\u001f<>]/.test(displayName + agentName)) throw bad("이름에 쓸 수 없는 문자가 있어요", "invalid_field");
      const device = parseDevice(body.device);
      if (core.db.userByHandle(handle)) throw new HttpError(409, "handle_taken", "이미 사용 중인 아이디예요");

      const passwordHash = await hashPassword(core, body.password);
      const userId = newId("u");
      const now = core.now();
      try {
        core.db.createUser({ id: userId, handle, displayName, agentName, passwordHash, settingsJson: JSON.stringify(defaultSettings()), createdAt: now });
      } catch {
        throw new HttpError(409, "handle_taken", "이미 사용 중인 아이디예요");
      }
      core.db.upsertDevice(userId, device, now);
      try {
        await core.deps.launcher.provision(userId, { agentName, displayName, enabledSkills: defaultSkillIds(core) });
      } catch (err) {
        core.log.error("provision failed", { user: userId, err: errInfo(err) });
      }
      const user = core.db.userById(userId)!;
      ensureMainThread(core, user);
      const token = issueSession(core, userId, device.id);
      core.log.info("signup", { user: userId });
      const res: AuthResponse = { token, session: await bootstrap(core, core.db.userById(userId)!) };
      return json(res, 201);
    },

    login: async (c: Ctx) => {
      limit(c);
      const body = await readJson(c.req);
      const handle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const device = parseDevice(body.device);
      const user = HANDLE_RE.test(handle) ? core.db.userByHandle(handle) : null;
      let ok = false;
      if (user && password.length <= 128) {
        ok = await Bun.password.verify(password, user.password_hash).catch(() => false);
      } else {
        // equalise timing for unknown handles
        dummyHash ??= hashPassword(core, "pickle-dummy-password");
        await Bun.password.verify(password.slice(0, 128) || "x", await dummyHash).catch(() => false);
      }
      if (!user || !ok) throw new HttpError(401, "invalid_credentials", LOGIN_FAILED);
      const now = core.now();
      core.db.upsertDevice(user.id, device, now);
      try {
        if (!(await core.deps.launcher.profile(user.id)))
          await core.deps.launcher.provision(user.id, { agentName: user.agent_name, displayName: user.display_name, enabledSkills: defaultSkillIds(core) });
      } catch (err) {
        core.log.warn("login provision check failed", { user: user.id, err: errInfo(err) });
      }
      const token = issueSession(core, user.id, device.id);
      core.log.info("login", { user: user.id });
      const res: AuthResponse = { token, session: await bootstrap(core, user) };
      return json(res);
    },

    logout: (_c: Ctx, auth: AuthedUser) => {
      core.db.deleteSession(auth.tokenHash);
      return json({ ok: true });
    },

    session: async (_c: Ctx, auth: AuthedUser) => json(await bootstrap(core, core.db.userById(auth.userId)!)),
  };
}
