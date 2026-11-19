/**
 * Slack login relay: one short-lived sign-in session per user, driven in a throwaway browser (driver.ts).
 *
 *  start  {workspace?, method?, email: sealed}   → needs_code | needs_password | workspaces | connected | error
 *  step   {relayId, code|password|totp: sealed} | {relayId, teamId}  → next state
 *  cancel {relayId}
 *
 * Security model (mirrors the KakaoTalk login): the app seals every typed secret on the device for the enclave;
 * the relay opens an envelope right before typing it into Slack and drops the plaintext right after. Nothing typed is
 * stored, logged or shown to the LLM. The resulting `xoxc-` token and `d` cookie go straight into the vault
 * (saveSystem, kind "token") and are validated with auth.test through the regular Slack adapter (hub.connect).
 * Logs carry step names, timings, the state and a masked workspace ("s****c") only.
 * Every path ends in cleanup(): browser closed, its in-memory profile gone, held tokens dropped, timer cleared.
 */
import type {
  CredentialInfo,
  EnclaveEnvelope,
  KeepFor,
  LoginRelayErrorCode,
  LoginRelayResponse,
  LoginRelayState,
  LoginRelayWorkspace,
} from "@pickle/protocol";
import type { Core } from "../core.ts";
import { RateLimiter } from "../auth.ts";
import { markCredentialCardsSaved } from "../credentials.ts";
import { HttpError } from "../http.ts";
import { randomB64url } from "../util.ts";
import { DriverError, PlaywrightSlackDriver, type DriverOptions, type DriverOutcome, type SlackDriver, type SlackExtract, type SlackTeamSession, type SlackUrls } from "./driver.ts";

export const RELAY_MESSAGES: Record<LoginRelayErrorCode, string> = {
  wrong_code: "코드가 맞지 않아요. 메일에 온 코드를 다시 확인해 주세요.",
  wrong_password: "이메일이나 비밀번호가 맞지 않아요.",
  wrong_totp: "인증 코드가 맞지 않아요. 새 코드로 다시 입력해 주세요.",
  code_expired: "코드가 만료됐어요. 처음부터 다시 해 주세요.",
  too_many_attempts: "여러 번 틀려서 로그인을 멈췄어요. 잠시 뒤 처음부터 다시 해 주세요.",
  sso_unsupported: "이 워크스페이스는 회사 SSO(Google·Okta 등)로만 로그인할 수 있어요. 아직 지원하지 않아서 '고급: 토큰 직접 입력'을 써 주세요.",
  workspace_not_found: "워크스페이스를 찾지 못했어요. 주소를 확인해 주세요.",
  workspace_required: "비밀번호로 로그인하려면 워크스페이스 주소가 필요해요.",
  password_unavailable: "이 워크스페이스는 비밀번호 로그인을 쓰지 않아요. 이메일 코드로 로그인해 주세요.",
  invalid_email: "이메일 주소를 확인해 주세요.",
  no_account: "이 이메일로 가입된 Slack 계정을 찾지 못했어요.",
  captcha: "Slack이 사람인지 확인하는 단계를 요구해서 로그인을 멈췄어요. 잠시 뒤 다시 하거나 '고급: 토큰 직접 입력'을 써 주세요.",
  slack_ratelimited: "Slack에서 시도가 너무 많다고 해요. 몇 분 뒤 다시 해 주세요.",
  token_not_found: "로그인은 됐는데 Slack 연결 정보를 가져오지 못했어요. 다시 해 주세요.",
  auth_failed: "Slack 연결을 확인하지 못했어요. 다시 해 주세요.",
  timeout: "로그인 시간(5분)이 지났어요. 처음부터 다시 해 주세요.",
  cancelled: "로그인을 취소했어요.",
  browser_unavailable: "지금은 서버에서 Slack 로그인을 열 수 없어요. '고급: 토큰 직접 입력'을 써 주세요.",
  upstream: "Slack 로그인 화면이 예상과 달라 멈췄어요. 잠시 뒤 다시 해 주세요.",
  // Discord / Telegram relay codes (messenger-login/relay.ts); Slack never sends these
  phone_invalid: "전화번호를 다시 확인해 주세요.",
  phone_banned: "이 번호로는 로그인할 수 없어요.",
  flood_wait: "시도가 너무 많아 잠시 막혔어요. 잠시 뒤 다시 해 주세요.",
  unsupported: "이 계정은 아직 지원하지 않는 로그인 단계를 요구해요.",
  qr_rejected: "앱에서 로그인을 취소했어요.",
  not_configured: "이 서비스 연결은 아직 준비 중이에요.",
  network: "네트워크 문제로 로그인을 끝내지 못했어요. 잠시 뒤 다시 해 주세요.",
};

const RETRYABLE = new Set<LoginRelayErrorCode>(["wrong_code", "wrong_password", "wrong_totp"]);

export interface SlackLoginOptions {
  /** test seam: build the browser driver */
  driver?: (o: DriverOptions) => SlackDriver;
  urls?: SlackUrls;
  headless?: boolean;
  /** whole relay lifetime (default 5 min) */
  ttlMs?: number;
  /** relays with an open browser at once, server-wide (default 3) */
  maxConcurrent?: number;
  /** starts per user per window (default 5 per 15 min) */
  startsPerWindow?: number;
  windowMs?: number;
  /** wrong codes/passwords per relay before it stops (default 5) */
  maxAttempts?: number;
  stepTimeoutMs?: number;
  tokenTimeoutMs?: number;
}

export interface StartInput {
  workspace: string | null;
  method: "code" | "password";
  email: EnclaveEnvelope;
  keepFor: KeepFor;
}

export type StepInput = { relayId: string } & ({ kind: "code" | "password" | "totp"; sealed: EnclaveEnvelope } | { kind: "team"; teamId: string });

interface Relay {
  id: string;
  userId: string;
  domain: string | null;
  keepFor: KeepFor;
  createdAt: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  driver: SlackDriver | null;
  state: LoginRelayState | "starting";
  codeLength: number;
  busy: boolean;
  attempts: number;
  /** after a sign-in that produced several teams: tokens held (memory only) until the person picks one */
  held: SlackExtract | null;
  workspaces: LoginRelayWorkspace[] | null;
  closed: boolean;
}

/** "sionic" | "sionic.slack.com" | "https://sionic.slack.com/x" → "sionic"; "" → null; throws on anything else */
export function normalizeWorkspace(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new HttpError(400, "invalid_workspace", "워크스페이스 주소가 올바르지 않아요");
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname; // "https://sionic.slack.com/messages" → host only
    } catch {
      throw new HttpError(400, "invalid_workspace", "워크스페이스 주소가 올바르지 않아요");
    }
  } else {
    s = s.replace(/^([a-z0-9.-]+\.slack\.com)[/?#].*$/, "$1"); // "sionic.slack.com/x" → host only; other slashes stay and fail below
  }
  s = s.replace(/\.$/, "").replace(/\.slack\.com$/, "");
  if (s.length > 80 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.enterprise)?$/.test(s)) {
    throw new HttpError(400, "invalid_workspace", "워크스페이스 주소가 올바르지 않아요");
  }
  return s;
}

/** "sionic" → "s****c" (logs only) */
export function maskWorkspace(d: string | null): string {
  if (!d) return "-";
  const base = d.replace(/\.enterprise$/, "");
  if (base.length <= 2) return `${base[0] ?? ""}*`;
  return `${base[0]}${"*".repeat(Math.min(6, base.length - 2))}${base[base.length - 1]}`;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** Best-effort: drop references to plaintext strings (JS strings themselves are immutable). */
function scrub(o: Record<string, string> | null | undefined): void {
  if (!o) return;
  for (const k of Object.keys(o)) {
    o[k] = "";
    delete o[k];
  }
}

export class SlackLoginRelay {
  private readonly relays = new Map<string, Relay>(); // by userId (one per user)
  private readonly byId = new Map<string, Relay>();
  /** why a relay ended, so a late step gets a clear answer instead of 404 */
  private readonly tombstones = new Map<string, { userId: string; code: LoginRelayErrorCode; at: number }>();
  private readonly limiter: RateLimiter;
  private readonly ttlMs: number;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly makeDriver: (o: DriverOptions) => SlackDriver;
  private readonly driverOpts: DriverOptions;
  private closing = false;
  /** browsers still shutting down (awaited by close()) */
  private readonly closingDrivers = new Set<Promise<void>>();

  constructor(
    private readonly core: Core,
    opts: SlackLoginOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.limiter = new RateLimiter(opts.startsPerWindow ?? 5, opts.windowMs ?? 15 * 60_000, () => core.now());
    this.makeDriver = opts.driver ?? ((o) => new PlaywrightSlackDriver(o));
    const headless = opts.headless ?? process.env.PICKLE_SLACK_LOGIN_HEADLESS !== "0";
    this.driverOpts = { urls: opts.urls, headless, stepTimeoutMs: opts.stepTimeoutMs, tokenTimeoutMs: opts.tokenTimeoutMs };
  }

  /** test/diagnostic: open relays */
  get size(): number {
    return this.relays.size;
  }

  async start(userId: string, input: StartInput): Promise<LoginRelayResponse> {
    if (this.closing) throw new HttpError(503, "relay_unavailable", RELAY_MESSAGES.browser_unavailable);
    if (!this.limiter.hit(userId)) {
      const retry = this.limiter.retryAfter(userId);
      throw new HttpError(429, "rate_limited", "로그인 시도가 너무 잦아요. 잠시 뒤 다시 해 주세요.", { "Retry-After": String(retry) });
    }
    const prev = this.relays.get(userId);
    if (prev) await this.cleanup(prev, "cancelled", "replaced");
    const open = [...this.relays.values()].filter((r) => r.driver).length;
    if (open >= this.maxConcurrent) throw new HttpError(503, "relay_busy", "지금 로그인 요청이 많아요. 잠시 뒤 다시 해 주세요.", { "Retry-After": "30" });

    const id = randomB64url(18);
    const now = this.core.now();
    const r: Relay = {
      id,
      userId,
      domain: input.workspace,
      keepFor: input.keepFor,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      timer: null,
      driver: null,
      state: "starting",
      codeLength: 6,
      busy: true,
      attempts: 0,
      held: null,
      workspaces: null,
      closed: false,
    };
    this.relays.set(userId, r);
    this.byId.set(id, r);
    r.timer = setTimeout(() => void this.expire(r), this.ttlMs);
    (r.timer as { unref?: () => void }).unref?.();
    this.log(r, "start", { method: input.method });

    let secret: Record<string, string> | null = null;
    try {
      secret = await this.open(input.email, `${userId}:slack:login-relay:start`);
      const email = (secret.email ?? "").trim();
      if (!EMAIL_RE.test(email)) {
        await this.cleanup(r, "invalid_email", "invalid_email");
        throw new HttpError(400, "invalid_email", RELAY_MESSAGES.invalid_email);
      }
      r.driver = this.makeDriver({ ...this.driverOpts, onStep: (step, ms) => this.log(r, step, { ms }) });
      const out = await r.driver.start({ domain: r.domain, email, method: input.method });
      return await this.advance(r, out);
    } catch (e) {
      return await this.failed(r, e);
    } finally {
      scrub(secret);
      r.busy = false;
    }
  }

  async step(userId: string, input: StepInput): Promise<LoginRelayResponse> {
    const r = this.byId.get(input.relayId);
    if (!r || r.userId !== userId || r.closed) {
      const t = this.tombstones.get(input.relayId);
      if (t && t.userId === userId) return { relayId: input.relayId, state: "error", error: { code: t.code, message: RELAY_MESSAGES[t.code] }, expiresAt: t.at };
      throw new HttpError(404, "relay_not_found", "진행 중인 Slack 로그인이 없어요. 처음부터 다시 해 주세요.");
    }
    // the ttl timer can fire late on a busy event loop: the deadline itself decides
    if (Date.now() >= r.expiresAt) {
      await this.expire(r);
      return { relayId: r.id, state: "error", error: { code: "timeout", message: RELAY_MESSAGES.timeout }, expiresAt: r.expiresAt };
    }
    if (r.busy) throw new HttpError(409, "relay_busy", "이전 단계를 처리하고 있어요. 잠시만 기다려 주세요.");
    const wanted: Record<StepInput["kind"], LoginRelayState> = { code: "needs_code", password: "needs_password", totp: "needs_2fa", team: "workspaces" };
    if (r.state !== wanted[input.kind]) throw new HttpError(409, "wrong_step", "지금 단계에서 보낼 수 없는 값이에요. 화면을 새로고침해 주세요.");
    r.busy = true;
    const t0 = Date.now();
    let secret: Record<string, string> | null = null;
    try {
      if (input.kind === "team") {
        this.log(r, "pick_workspace");
        if (r.held) {
          const team = r.held.teams.find((t) => t.teamId === input.teamId);
          if (!team) throw new HttpError(400, "invalid_team", "목록에 없는 워크스페이스예요");
          return await this.finish(r, team, r.held.cookie);
        }
        const pick = r.workspaces?.find((w) => w.id === input.teamId);
        if (!pick) throw new HttpError(400, "invalid_team", "목록에 없는 워크스페이스예요");
        // remember the choice so the token of that team is taken even if the web client knows several
        if (pick.domain) r.domain = pick.domain.replace(/\.slack\.com$/, "");
        return await this.advance(r, await this.drv(r).pickWorkspace(input.teamId));
      }
      secret = await this.open(input.sealed, `${userId}:slack:login-relay:${r.id}`);
      const value = (secret[input.kind] ?? "").replace(input.kind === "password" ? /^$/ : /[\s-]/g, "");
      if (input.kind === "code") {
        if (!/^[A-Za-z0-9]{6}$/.test(value)) throw new HttpError(400, "invalid_code", "메일로 받은 6자리 코드를 입력해 주세요.");
        this.log(r, "code_submit");
        return await this.advance(r, await this.drv(r).submitCode(value.toUpperCase()));
      }
      if (input.kind === "totp") {
        if (!/^[A-Za-z0-9]{6,10}$/.test(value)) throw new HttpError(400, "invalid_code", "인증 앱의 6자리 코드를 입력해 주세요.");
        this.log(r, "totp_submit");
        return await this.advance(r, await this.drv(r).submitTotp(value));
      }
      if (!value || value.length > 256) throw new HttpError(400, "invalid_password", "비밀번호를 입력해 주세요.");
      this.log(r, "password_submit");
      return await this.advance(r, await this.drv(r).submitPassword(value));
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && !r.closed) throw e; // validation: keep the relay
      return await this.failed(r, e);
    } finally {
      scrub(secret);
      r.busy = false;
      this.log(r, "step_done", { ms: Date.now() - t0 });
    }
  }

  async cancel(userId: string, relayId: string): Promise<boolean> {
    const r = this.byId.get(relayId);
    if (!r || r.userId !== userId) return false;
    await this.cleanup(r, "cancelled", "cancel");
    return true;
  }

  /** server shutdown: close every browser */
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.relays.values()].map((r) => this.cleanup(r, "cancelled", "shutdown")));
    await this.idle();
  }

  /** resolves once every browser this relay opened has exited (tests, shutdown) */
  async idle(): Promise<void> {
    while (this.closingDrivers.size) await Promise.allSettled([...this.closingDrivers]);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private drv(r: Relay): SlackDriver {
    if (!r.driver || r.closed) throw new DriverError("cancelled", "no driver");
    return r.driver;
  }

  private async open(env: EnclaveEnvelope, aad: string): Promise<Record<string, string>> {
    const enclave = this.core.deps.enclave;
    if (!enclave.openEnvelope) throw new HttpError(503, "relay_unavailable", RELAY_MESSAGES.browser_unavailable);
    try {
      return await enclave.openEnvelope(env, aad);
    } catch {
      throw new HttpError(400, "invalid_envelope", "기기에서 암호화한 값이 아니에요. 화면을 새로고침한 뒤 다시 해 주세요.");
    }
  }

  /** fold one driver answer into the relay and answer the client */
  private async advance(r: Relay, out: DriverOutcome): Promise<LoginRelayResponse> {
    if (r.closed) return this.respondClosed(r);
    switch (out.kind) {
      case "needs_code":
      case "needs_2fa":
        if (r.state !== out.kind) r.attempts = 0; // a new prompt gets its own tries
        r.state = out.kind;
        r.codeLength = out.codeLength;
        this.log(r, "state");
        return this.respond(r);
      case "needs_password":
        if (r.state !== "needs_password") r.attempts = 0;
        r.state = "needs_password";
        this.log(r, "state");
        return this.respond(r);
      case "workspaces": {
        if (out.workspaces.length === 1) {
          this.log(r, "auto_pick");
          return this.advance(r, await this.drv(r).pickWorkspace(out.workspaces[0]!.id));
        }
        r.state = "workspaces";
        r.workspaces = out.workspaces;
        this.log(r, "state", { n: out.workspaces.length });
        return this.respond(r);
      }
      case "signed_in":
        return this.signedIn(r);
      case "error": {
        if (RETRYABLE.has(out.code)) {
          r.attempts++;
          this.log(r, "retry", { err: out.code, n: r.attempts });
          if (r.attempts >= this.maxAttempts) return this.terminal(r, "too_many_attempts");
          return { ...this.respond(r), error: { code: out.code, message: RELAY_MESSAGES[out.code] } };
        }
        return this.terminal(r, out.code);
      }
    }
  }

  private async signedIn(r: Relay): Promise<LoginRelayResponse> {
    const driver = this.drv(r);
    const ex = await driver.extract();
    // the tokens are in hand: the browser is not needed any more
    r.driver = null;
    this.closeDriver(driver);
    let teams = ex.teams;
    if (r.domain) {
      const want = r.domain.replace(/\.enterprise$/, "");
      const match = teams.filter((t) => t.domain === want || t.domain === r.domain);
      if (match.length) teams = match;
    }
    if (teams.length === 1) return this.finish(r, teams[0]!, ex.cookie);
    r.held = { teams, cookie: ex.cookie };
    r.state = "workspaces";
    r.workspaces = teams.map((t) => ({ id: t.teamId, name: t.name ?? t.domain ?? t.teamId, domain: t.domain ? `${t.domain}.slack.com` : null }));
    this.log(r, "state", { n: teams.length });
    return this.respond(r);
  }

  /** seal the session into the vault, validate it with auth.test (hub.connect → Slack adapter), then close the relay */
  private async finish(r: Relay, team: SlackTeamSession, cookie: string): Promise<LoginRelayResponse> {
    const { vault, hub } = this.core.deps;
    if (!vault.saveSystem) return this.terminal(r, "browser_unavailable");
    const t0 = Date.now();
    let saved: CredentialInfo | null = null;
    const secret: Record<string, string> = { token: team.token, cookie };
    try {
      const where = team.domain ? `${team.domain}.slack.com` : (team.name ?? "Slack");
      saved = await vault.saveSystem(r.userId, {
        service: "slack",
        label: `슬랙 (${where})`.slice(0, 80),
        kind: "token",
        hint: where.slice(0, 64),
        keepFor: r.keepFor,
        secret,
      });
    } finally {
      scrub(secret);
      this.dropHeld(r);
    }
    let res;
    try {
      // session: the connection owns it (hub signs it out at Slack + deletes it on disconnect, replaces it on re-login)
      res = await hub.connect(r.userId, "slack", { credentialId: saved.id }, { session: true });
    } catch (e) {
      await vault.remove(r.userId, saved.id).catch(() => {});
      // name + code only: an SDK error message could echo request details
      this.core.log.warn("slack_login connect failed", { relay: r.id.slice(0, 6), err: e instanceof Error ? e.name : "unknown", code: typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code.slice(0, 40) : null });
      return this.terminal(r, "auth_failed");
    }
    if (res.connection.status !== "connected") {
      await vault.remove(r.userId, saved.id).catch(() => {});
      return this.terminal(r, "auth_failed");
    }
    markCredentialCardsSaved(this.core, r.userId, "slack");
    r.state = "connected";
    this.log(r, "connected", { ms: Date.now() - t0 });
    const out: LoginRelayResponse = { relayId: r.id, state: "connected", connection: res.connection, expiresAt: r.expiresAt };
    await this.cleanup(r, null, "done");
    return out;
  }

  private async failed(r: Relay, e: unknown): Promise<LoginRelayResponse> {
    if (e instanceof HttpError) {
      if (!r.closed) await this.cleanup(r, "upstream", "http_error");
      throw e;
    }
    if (e instanceof DriverError) return this.terminal(r, e.code);
    // never log the raw message of a browser error: it is generic, but stay on the safe side
    this.core.log.warn("slack_login failed", { relay: r.id.slice(0, 6), err: e instanceof Error ? e.name : "unknown" });
    return this.terminal(r, r.closed ? "cancelled" : "upstream");
  }

  private async terminal(r: Relay, code: LoginRelayErrorCode): Promise<LoginRelayResponse> {
    const out: LoginRelayResponse = { relayId: r.id, state: "error", error: { code, message: RELAY_MESSAGES[code] }, expiresAt: r.expiresAt };
    await this.cleanup(r, code, code);
    return out;
  }

  private respond(r: Relay): LoginRelayResponse {
    const state = r.state === "starting" ? "error" : r.state;
    const out: LoginRelayResponse = { relayId: r.id, state, expiresAt: r.expiresAt };
    if (state === "needs_code" || state === "needs_2fa") out.codeLength = r.codeLength;
    if (state === "workspaces") out.workspaces = r.workspaces ?? [];
    return out;
  }

  private respondClosed(r: Relay): LoginRelayResponse {
    const t = this.tombstones.get(r.id);
    const code = t?.code ?? "cancelled";
    return { relayId: r.id, state: "error", error: { code, message: RELAY_MESSAGES[code] }, expiresAt: r.expiresAt };
  }

  private async expire(r: Relay): Promise<void> {
    if (r.closed) return;
    this.log(r, "timeout");
    await this.cleanup(r, "timeout", "timeout");
  }

  private dropHeld(r: Relay): void {
    if (!r.held) return;
    for (const t of r.held.teams) t.token = "";
    r.held.cookie = "";
    r.held = null;
  }

  /** the one exit: close the browser, drop held tokens, clear the timer, forget the relay */
  private async cleanup(r: Relay, code: LoginRelayErrorCode | null, why: string): Promise<void> {
    if (r.closed) return;
    r.closed = true;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    this.dropHeld(r);
    const driver = r.driver;
    r.driver = null;
    if (this.relays.get(r.userId) === r) this.relays.delete(r.userId);
    this.byId.delete(r.id);
    if (code) this.tombstones.set(r.id, { userId: r.userId, code, at: this.core.now() });
    this.sweepTombstones();
    if (driver) this.closeDriver(driver);
    this.log(r, "closed", { why });
  }

  /** browser shutdown never delays an answer; close() waits for all of them */
  private closeDriver(d: SlackDriver): void {
    const p: Promise<void> = d
      .close()
      .catch(() => {})
      .finally(() => this.closingDrivers.delete(p));
    this.closingDrivers.add(p);
  }

  private sweepTombstones(): void {
    const cutoff = this.core.now() - 15 * 60_000;
    for (const [k, v] of this.tombstones) if (v.at < cutoff) this.tombstones.delete(k);
    if (this.tombstones.size > 1000) this.tombstones.clear();
  }

  /** step names, timings, state and a masked workspace only */
  private log(r: Relay, step: string, extra: Record<string, string | number> = {}): void {
    this.core.log.info("slack_login", { relay: r.id.slice(0, 6), step, ws: maskWorkspace(r.domain), state: r.state, ...extra });
  }
}
