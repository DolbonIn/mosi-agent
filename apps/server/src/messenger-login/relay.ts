/**
 * Messenger login relay for Discord (remote auth: approve in the Discord app / scan a QR) and Telegram (phone → code →
 * 2FA password). Same protocol and routes as the Slack relay (slack-login/relay.ts); the provider drivers live in
 * @pickle/messengers/login.
 *
 *  discord  start {}            → waiting_scan {qrUrl, pollMs}
 *           step {relayId}       (poll) → waiting_scan | waiting_confirm {account} | connected | expired | cancelled | error
 *  telegram start {}            → needs_phone            (or error not_configured when the operator has no api_id)
 *           step {relayId, phone} → needs_code {codeLength, codeVia, phoneMasked}
 *           step {relayId, code}  → needs_password {passwordHint?} | connected
 *           step {relayId, password} → connected
 *  cancel {relayId}
 *
 * Security: every typed value (phone, code, password) arrives sealed on the device for the enclave, bound to
 * `${userId}:${provider}:login-relay:${relayId}` (one-time relay id → unique per relay); an envelope is accepted once
 * (iv replay guard), opened right before the driver call and dropped right after. Nothing typed is stored, logged or
 * shown to the LLM. The session secret a login produces goes straight into the vault (saveSystem, kind "token") and is
 * validated by the regular adapter through hub.connect. Logs carry the relay id prefix, provider, step, state and error
 * code only. Each relay is one-time, lives at most 5 minutes, is rate-limited per user, and every path ends in
 * cleanup(): sockets closed, TDLib closed, unfinished TDLib files removed, timer cleared.
 */
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Connection, CredentialInfo, EnclaveEnvelope, KeepFor, LoginRelayErrorCode, LoginRelayResponse, LoginRelayState } from "@pickle/protocol";
import type * as LoginMod from "@pickle/messengers/login";
import type { Core } from "../core.ts";
import { RateLimiter } from "../auth.ts";
import { markCredentialCardsSaved } from "../credentials.ts";
import { HttpError } from "../http.ts";
import { randomB64url } from "../util.ts";

export type LoginProvider = "discord" | "telegram";
export const LOGIN_PROVIDERS: readonly LoginProvider[] = ["discord", "telegram"];

const NAMES: Record<LoginProvider, string> = { discord: "디스코드", telegram: "텔레그램" };

export const MESSAGES: Partial<Record<LoginRelayErrorCode, string>> = {
  timeout: "로그인 시간이 지났어요. 처음부터 다시 해 주세요.",
  cancelled: "로그인을 취소했어요.",
  too_many_attempts: "여러 번 틀려서 로그인을 멈췄어요. 잠시 뒤 처음부터 다시 해 주세요.",
  auth_failed: "로그인은 됐는데 연결을 확인하지 못했어요. 다시 해 주세요.",
  not_configured: "텔레그램 연결은 아직 준비 중이에요.",
  upstream: "로그인을 끝내지 못했어요. 잠시 뒤 다시 해 주세요.",
  network: "네트워크 문제로 로그인을 끝내지 못했어요. 잠시 뒤 다시 해 주세요.",
};

export type TelegramReadiness = Awaited<ReturnType<typeof LoginMod.telegramReadiness>>;

export interface MessengerLoginOptions {
  /** whole relay lifetime (default 5 min) */
  ttlMs?: number;
  /** starts per user per window, all providers together (default 6 per 15 min: a Discord QR may need a fresh one) */
  startsPerWindow?: number;
  windowMs?: number;
  /** wrong codes/passwords/numbers per relay before it stops (default 5) */
  maxAttempts?: number;
  /** open relays server-wide (default 30) */
  maxConcurrent?: number;
  /** how often the app polls while waiting on another device (default 2 s) */
  pollMs?: number;
  /** per TDLib step (default 20 s) */
  stepTimeoutMs?: number;
  /** where per-user messenger files live (default `<dataDir>/messengers`, the hub's configRoot) */
  configRoot?: string;
  /** test seams */
  discordLogin?: () => Promise<LoginMod.LoginWithRemoteAuth>;
  discordSocket?: (url: string) => LoginMod.RemoteAuthSocket;
  discordFetch?: typeof fetch;
  telegram?: () => Promise<TelegramReadiness>;
}

export type StepKind = "poll" | "phone" | "code" | "password";
export interface StepInput {
  relayId: string;
  kind: StepKind;
  sealed?: EnclaveEnvelope;
}

interface Relay {
  id: string;
  userId: string;
  provider: LoginProvider;
  keepFor: KeepFor;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  busy: boolean;
  attempts: number;
  view: LoginMod.LoginView;
  /** QR image of view.qrUrl (data URI), rendered once per link */
  qr: { url: string; svg: string | null } | null;
  ivs: Set<string>;
  discord: LoginMod.DiscordRemoteAuth | null;
  telegram: LoginMod.TelegramLogin | null;
  finishing: Promise<void> | null;
}

interface Tomb {
  userId: string;
  res: LoginRelayResponse;
  at: number;
}

/** Best-effort: drop references to plaintext strings (JS strings themselves are immutable). */
function scrub(o: Record<string, string> | null | undefined): void {
  if (!o) return;
  for (const k of Object.keys(o)) {
    o[k] = "";
    delete o[k];
  }
}

const WAITING: ReadonlySet<LoginRelayState> = new Set(["waiting_scan", "waiting_confirm"]);
const RETRYABLE = new Set(["wrong_code", "wrong_password", "phone_invalid"]);

export class MessengerLoginRelay {
  private readonly relays = new Map<string, Relay>(); // by userId (one per user, all providers)
  private readonly byId = new Map<string, Relay>();
  private readonly tombs = new Map<string, Tomb>();
  private readonly limiter: RateLimiter;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly maxConcurrent: number;
  private readonly pollMs: number;
  private readonly stepTimeoutMs: number;
  private readonly configRoot: string;
  private mod: Promise<typeof LoginMod> | null = null;
  private closing = false;
  private readonly background = new Set<Promise<unknown>>();

  constructor(
    private readonly core: Core,
    private readonly opts: MessengerLoginOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.maxConcurrent = opts.maxConcurrent ?? 30;
    this.pollMs = opts.pollMs ?? 2_000;
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 20_000;
    this.configRoot = opts.configRoot ?? join(core.cfg.dataDir, "messengers");
    this.limiter = new RateLimiter(opts.startsPerWindow ?? 6, opts.windowMs ?? 15 * 60_000, () => core.now());
  }

  get size(): number {
    return this.relays.size;
  }

  /** Telegram: false until the operator configured api_id/api_hash and TDLib loads */
  async telegramReady(): Promise<boolean> {
    return (await this.readiness()).ok;
  }

  async start(userId: string, provider: LoginProvider, input: { keepFor: KeepFor }): Promise<LoginRelayResponse> {
    if (this.closing) throw new HttpError(503, "relay_unavailable", "지금은 로그인을 시작할 수 없어요. 잠시 뒤 다시 해 주세요.");
    if (!this.limiter.hit(userId)) {
      const retry = this.limiter.retryAfter(userId);
      throw new HttpError(429, "rate_limited", "로그인 시도가 너무 잦아요. 잠시 뒤 다시 해 주세요.", { "Retry-After": String(retry) });
    }
    const prev = this.relays.get(userId);
    if (prev) await this.cleanup(prev, { state: "cancelled", code: "cancelled" }, "replaced");
    if (this.relays.size >= this.maxConcurrent) throw new HttpError(503, "relay_busy", "지금 로그인 요청이 많아요. 잠시 뒤 다시 해 주세요.", { "Retry-After": "30" });

    const id = randomB64url(18);
    const r: Relay = {
      id,
      userId,
      provider,
      keepFor: input.keepFor,
      expiresAt: this.core.now() + this.ttlMs,
      timer: null,
      closed: false,
      busy: true,
      attempts: 0,
      view: provider === "discord" ? { state: "waiting_scan" } : { state: "needs_phone" },
      qr: null,
      ivs: new Set(),
      discord: null,
      telegram: null,
      finishing: null,
    };
    this.relays.set(userId, r);
    this.byId.set(id, r);
    r.timer = setTimeout(() => void this.expire(r), this.ttlMs);
    (r.timer as { unref?: () => void }).unref?.();
    this.log(r, "start");
    try {
      const m = await this.load();
      if (provider === "discord") {
        const login = await (this.opts.discordLogin ?? m.loadDiscordRemoteAuth)();
        r.discord = new m.DiscordRemoteAuth({
          login,
          socket: this.opts.discordSocket,
          fetchImpl: this.opts.discordFetch,
          // the gateway closes on its own (~4 min); never outlive the relay
          timeoutMs: Math.max(1_000, this.ttlMs - 5_000),
          onChange: (v) => this.onDiscord(r, v),
        });
        r.view = await r.discord.start();
        if (r.view.qrUrl) r.qr = { url: r.view.qrUrl, svg: await m.qrSvgDataUri(r.view.qrUrl) };
        // the app's countdown follows Discord's own QR lifetime when it is shorter than the relay's
        const gw = r.discord.gatewayTimeoutMs;
        if (gw) r.expiresAt = Math.min(r.expiresAt, this.core.now() + gw - 1_000);
      } else {
        const ready = await this.readiness();
        if (!ready.ok) return await this.terminal(r, "error", "not_configured");
        r.telegram = new m.TelegramLogin({
          client: () => ready.runtime.client(),
          app: ready.app,
          configDir: m.userConfigDir(this.configRoot, userId),
          stepTimeoutMs: this.stepTimeoutMs,
        });
        r.view = await r.telegram.start();
      }
      return await this.after(r);
    } catch (e) {
      return await this.failed(r, e);
    } finally {
      r.busy = false;
    }
  }

  async step(userId: string, input: StepInput): Promise<LoginRelayResponse> {
    const r = this.byId.get(input.relayId);
    if (!r || r.userId !== userId || r.closed) {
      const t = this.tombs.get(input.relayId);
      if (t && t.userId === userId) return t.res;
      throw new HttpError(404, "relay_not_found", "진행 중인 로그인이 없어요. 처음부터 다시 해 주세요.");
    }
    if (input.kind === "poll") return this.respond(r);
    if (r.busy || r.finishing) throw new HttpError(409, "relay_busy", "이전 단계를 처리하고 있어요. 잠시만 기다려 주세요.");
    const wanted: Record<Exclude<StepKind, "poll">, LoginRelayState> = { phone: "needs_phone", code: "needs_code", password: "needs_password" };
    if (r.provider !== "telegram" || !r.telegram || r.view.state !== wanted[input.kind]) {
      throw new HttpError(409, "wrong_step", "지금 단계에서 보낼 수 없는 값이에요. 화면을 새로고침해 주세요.");
    }
    const sealed = input.sealed!;
    if (r.ivs.has(sealed.iv)) throw new HttpError(400, "invalid_envelope", "이미 보낸 값이에요. 다시 입력해 주세요.");
    r.ivs.add(sealed.iv);
    r.busy = true;
    const t0 = Date.now();
    let secret: Record<string, string> | null = null;
    try {
      secret = await this.open(sealed, `${userId}:${r.provider}:login-relay:${r.id}`);
      const value = secret[input.kind] ?? "";
      this.log(r, `${input.kind}_submit`);
      if (input.kind === "phone") r.view = await r.telegram.submitPhone(value);
      else if (input.kind === "code") r.view = await r.telegram.submitCode(value);
      else r.view = await r.telegram.submitPassword(value);
      return await this.after(r);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && !r.closed) throw e; // validation: keep the relay
      return await this.failed(r, e);
    } finally {
      scrub(secret);
      secret = null;
      r.busy = false;
      this.log(r, "step_done", { ms: Date.now() - t0 });
    }
  }

  async cancel(userId: string, relayId: string): Promise<boolean> {
    const r = this.byId.get(relayId);
    if (!r || r.userId !== userId) return false;
    await this.cleanup(r, { state: "cancelled", code: "cancelled" }, "cancel");
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.relays.values()].map((r) => this.cleanup(r, { state: "cancelled", code: "cancelled" }, "shutdown")));
    await this.idle();
  }

  /** resolves once background hand-offs/cleanups settle (tests, shutdown) */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  // ───────────────────────────── internals ─────────────────────────────

  private load(): Promise<typeof LoginMod> {
    this.mod ??= import("@pickle/messengers/login");
    this.mod.catch(() => {
      this.mod = null;
    });
    return this.mod;
  }

  private async readiness(): Promise<TelegramReadiness> {
    if (this.opts.telegram) return this.opts.telegram();
    try {
      return await (await this.load()).telegramReadiness();
    } catch {
      return { ok: false, reason: "tdlib_missing" };
    }
  }

  private async open(env: EnclaveEnvelope, aad: string): Promise<Record<string, string>> {
    const enclave = this.core.deps.enclave;
    if (!enclave.openEnvelope) throw new HttpError(503, "relay_unavailable", "지금은 로그인을 진행할 수 없어요.");
    try {
      return await enclave.openEnvelope(env, aad);
    } catch {
      throw new HttpError(400, "invalid_envelope", "기기에서 암호화한 값이 아니에요. 화면을 새로고침한 뒤 다시 해 주세요.");
    }
  }

  /** Discord pushes its states (scan, confirm, done, expiry) while the app polls. */
  private onDiscord(r: Relay, v: LoginMod.LoginView): void {
    if (r.closed) return;
    r.view = v;
    this.log(r, "state");
    if (r.busy) return; // start() is still running: it calls after() itself
    this.track(this.after(r));
  }

  /** fold the driver's latest view into the relay: retry counting, hand-off on done, cleanup on terminal states */
  private async after(r: Relay): Promise<LoginRelayResponse> {
    if (r.closed) return this.tombOf(r);
    const v = r.view;
    if (v.state === "done") {
      r.finishing ??= this.finish(r);
      if (r.provider === "telegram") await r.finishing;
      return r.closed ? this.tombOf(r) : this.respond(r);
    }
    if (v.state === "expired") return this.terminal(r, "expired", "timeout", v.error?.message);
    if (v.state === "cancelled") return this.terminal(r, "cancelled", v.error?.code === "qr_rejected" ? "qr_rejected" : "cancelled", v.error?.message);
    if (v.state === "error") return this.terminal(r, "error", (v.error?.code ?? "upstream") as LoginRelayErrorCode, v.error?.message);
    if (v.error && RETRYABLE.has(v.error.code)) {
      r.attempts++;
      this.log(r, "retry", { err: v.error.code, n: r.attempts });
      if (r.attempts >= this.maxAttempts) return this.terminal(r, "error", "too_many_attempts");
    }
    return this.respond(r);
  }

  /** seal the session into the vault, validate it through the adapter (hub.connect), close the relay */
  private async finish(r: Relay): Promise<void> {
    const { vault, hub } = this.core.deps;
    const result = r.discord?.result() ?? r.telegram?.result() ?? null;
    if (!result || !vault.saveSystem) {
      await this.terminal(r, "error", "auth_failed");
      return;
    }
    const t0 = Date.now();
    const name = NAMES[r.provider];
    let saved: CredentialInfo | null = null;
    try {
      const who = result.accountLabel ? `${name} (${result.accountLabel})` : name;
      saved = await vault.saveSystem(r.userId, {
        service: r.provider,
        label: who.slice(0, 80),
        kind: "token",
        hint: (result.accountLabel ?? "앱 로그인").slice(0, 64),
        keepFor: r.keepFor,
        secret: result.secret,
      });
    } catch {
      await r.telegram?.dispose(false);
      await this.terminal(r, "error", "auth_failed");
      return;
    } finally {
      scrub(result.secret);
    }
    let conn: Connection | null = null;
    try {
      // session mode: the connection owns this row — disconnect revokes + removes it, a re-login replaces it
      const res = await hub.connect(r.userId, r.provider, { credentialId: saved.id }, { session: true });
      conn = res.connection.status === "connected" ? res.connection : null;
    } catch {
      conn = null;
    }
    if (!conn) {
      await vault.remove(r.userId, saved.id).catch(() => {});
      await r.telegram?.dispose(false);
      await this.terminal(r, "error", "auth_failed");
      return;
    }
    markCredentialCardsSaved(this.core, r.userId, r.provider);
    if (r.provider === "telegram") await this.dropOldTelegramDirs(r);
    await r.telegram?.dispose(true);
    this.log(r, "connected", { ms: Date.now() - t0 });
    const res: LoginRelayResponse = { relayId: r.id, state: "connected", connection: conn, expiresAt: r.expiresAt };
    await this.cleanup(r, { res }, "done");
  }

  /**
   * After a Telegram re-login: the hub already removed the previous session credential (session mode); its database
   * directory is now unreadable. Delete every account directory but the new one.
   */
  private async dropOldTelegramDirs(r: Relay): Promise<void> {
    const m = await this.load();
    const base = join(m.userConfigDir(this.configRoot, r.userId), m.TELEGRAM_DIR);
    const keep = r.telegram?.directory;
    if (!keep) return;
    const entries = await readdir(base).catch(() => [] as string[]);
    await Promise.all(entries.filter((e) => e !== keep).map((e) => rm(join(base, e), { recursive: true, force: true }).catch(() => {})));
  }

  private async failed(r: Relay, e: unknown): Promise<LoginRelayResponse> {
    if (e instanceof HttpError) {
      if (!r.closed) await this.cleanup(r, { state: "error", code: "upstream" }, "http_error");
      throw e;
    }
    this.core.log.warn("messenger_login failed", { relay: r.id.slice(0, 6), provider: r.provider, err: e instanceof Error ? e.name : "unknown" });
    return this.terminal(r, r.closed ? "cancelled" : "error", r.closed ? "cancelled" : "upstream");
  }

  private async terminal(r: Relay, state: "expired" | "cancelled" | "error", code: LoginRelayErrorCode, message?: string): Promise<LoginRelayResponse> {
    await this.cleanup(r, { state, code, message }, code);
    return this.tombOf(r);
  }

  private respond(r: Relay): LoginRelayResponse {
    const v = r.view;
    // `done` (Discord hand-off still running) still reads as "approved, finishing"
    const state: LoginRelayState = v.state === "done" ? "waiting_confirm" : (v.state as LoginRelayState);
    const out: LoginRelayResponse = { relayId: r.id, state, expiresAt: r.expiresAt };
    if (v.qrUrl && state === "waiting_scan") {
      out.qrUrl = v.qrUrl;
      if (r.qr?.url === v.qrUrl && r.qr.svg) out.qrSvg = r.qr.svg;
    }
    if (v.account) out.account = { ...v.account };
    if (state === "needs_code") {
      if (v.codeLength) out.codeLength = v.codeLength;
      if (v.codeVia) out.codeVia = v.codeVia;
      if (v.phoneMasked) out.phoneMasked = v.phoneMasked;
    }
    if (state === "needs_password" && v.passwordHint) out.passwordHint = v.passwordHint;
    if (WAITING.has(state)) out.pollMs = this.pollMs;
    if (v.error && RETRYABLE.has(v.error.code)) out.error = { code: v.error.code as LoginRelayErrorCode, message: v.error.message };
    return out;
  }

  private tombOf(r: Relay): LoginRelayResponse {
    return this.tombs.get(r.id)?.res ?? { relayId: r.id, state: "cancelled", error: { code: "cancelled", message: MESSAGES.cancelled! }, expiresAt: r.expiresAt };
  }

  private async expire(r: Relay): Promise<void> {
    if (r.closed || r.finishing) return;
    this.log(r, "timeout");
    await this.cleanup(r, { state: "expired", code: "timeout" }, "timeout");
  }

  /**
   * The one exit: stop the driver (socket / TDLib + unfinished files), clear the timer, forget the relay, leave a
   * tombstone so a late poll gets the final answer.
   */
  private async cleanup(
    r: Relay,
    end: { res: LoginRelayResponse } | { state: "expired" | "cancelled" | "error"; code: LoginRelayErrorCode; message?: string },
    why: string,
  ): Promise<void> {
    if (r.closed) return;
    r.closed = true;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    if (this.relays.get(r.userId) === r) this.relays.delete(r.userId);
    this.byId.delete(r.id);
    const res: LoginRelayResponse =
      "res" in end
        ? end.res
        : { relayId: r.id, state: end.state, error: { code: end.code, message: end.message ?? MESSAGES[end.code] ?? MESSAGES.upstream! }, expiresAt: r.expiresAt };
    this.tombs.set(r.id, { userId: r.userId, res, at: this.core.now() });
    this.sweepTombs();
    const discord = r.discord;
    const telegram = r.telegram;
    r.discord = null;
    r.telegram = null;
    r.ivs.clear();
    const stop = (async () => {
      if (discord) await discord.cancel().catch(() => {});
      // a finished hand-off already closed TDLib and kept the files; anything else removes them
      if (telegram && why !== "done") await telegram.dispose(false).catch(() => {});
    })();
    this.track(stop);
    this.log(r, "closed", { why });
  }

  private sweepTombs(): void {
    const cutoff = this.core.now() - 15 * 60_000;
    for (const [k, v] of this.tombs) if (v.at < cutoff) this.tombs.delete(k);
    if (this.tombs.size > 1000) this.tombs.clear();
  }

  private track(p: Promise<unknown>): void {
    const t = p.catch(() => {}).finally(() => this.background.delete(t));
    this.background.add(t);
  }

  /** relay id prefix, provider, step, state, error code, counters — never a typed value, token or QR link */
  private log(r: Relay, step: string, extra: Record<string, string | number> = {}): void {
    this.core.log.info("messenger_login", { relay: r.id.slice(0, 6), provider: r.provider, step, state: r.view.state, ...extra });
  }
}
