/**
 * Telegram user-account login over TDLib: phone → the code Telegram sends (to the Telegram app, or SMS) → the 2FA
 * password when one is set → a logged-in TDLib database.
 *
 * Session model: the TDLib database lives under `<configDir>/telegram/<tdDir>` and is encrypted with a random
 * 32-byte `database_encryption_key`. Only that key (plus the directory name) becomes the session secret the vault
 * seals; the files are useless without it. The operator's api_id/api_hash come from the server environment and never
 * reach a client.
 *
 * The phone number, code and password are passed straight to TDLib and dropped; they are never logged or stored.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Secret } from "../adapters/types";
import { clip } from "../util";
import { TdError, type TdClient, type TdObject } from "../tdlib/runtime";
import { maskPhone, normalizePhone, TERMINAL, type LoginResult, type LoginView } from "./types";

export interface TelegramApp {
  apiId: number;
  apiHash: string;
}

/** Operator registration from the environment (my.telegram.org). Same variable names agent-messenger reads. */
export function telegramAppFromEnv(env: Record<string, string | undefined> = process.env): TelegramApp | null {
  const id = (env.AGENT_TELEGRAM_API_ID ?? env.AGENT_MESSENGER_TELEGRAM_API_ID ?? "").trim();
  const hash = (env.AGENT_TELEGRAM_API_HASH ?? env.AGENT_MESSENGER_TELEGRAM_API_HASH ?? "").trim();
  if (!/^\d{1,12}$/.test(id) || !/^[0-9a-f]{32}$/i.test(hash)) return null;
  const apiId = Number.parseInt(id, 10);
  return apiId > 0 ? { apiId, apiHash: hash } : null;
}

export const TELEGRAM_DIR = "telegram";

/** `setTdlibParameters` for one account directory (login and every later session open). */
export function tdlibParameters(app: TelegramApp, dir: string, databaseKey: string): TdObject {
  return {
    "@type": "setTdlibParameters",
    use_test_dc: false,
    database_directory: join(dir, "db"),
    files_directory: join(dir, "files"),
    database_encryption_key: databaseKey,
    use_file_database: false,
    use_chat_info_database: true,
    use_message_database: true,
    use_secret_chats: false,
    api_id: app.apiId,
    api_hash: app.apiHash,
    system_language_code: "ko",
    device_model: "모시",
    system_version: "server",
    application_version: "1.0",
  };
}

const CODE_VIA: Record<string, LoginView["codeVia"]> = {
  authenticationCodeTypeTelegramMessage: "app",
  authenticationCodeTypeSms: "sms",
  authenticationCodeTypeSmsWord: "sms",
  authenticationCodeTypeSmsPhrase: "sms",
  authenticationCodeTypeFirebaseAndroid: "sms",
  authenticationCodeTypeFirebaseIos: "sms",
  authenticationCodeTypeCall: "call",
  authenticationCodeTypeFlashCall: "call",
  authenticationCodeTypeMissedCall: "call",
  authenticationCodeTypeFragment: "app",
};

/** seconds from "Too Many Requests: retry after 123" / "FLOOD_WAIT_123" */
function floodSeconds(e: TdError): number | null {
  const m = /retry after (\d+)|FLOOD_WAIT_(\d+)/i.exec(e.message);
  if (m) return Number(m[1] ?? m[2]);
  return e.code === 429 ? 60 : null;
}

function floodMessage(sec: number): string {
  const min = Math.max(1, Math.ceil(sec / 60));
  return min >= 60 ? `텔레그램이 시도를 잠시 막았어요. ${Math.ceil(min / 60)}시간쯤 뒤에 다시 시도해 주세요.` : `텔레그램이 시도를 잠시 막았어요. ${min}분 뒤에 다시 시도해 주세요.`;
}

export interface TelegramLoginOptions {
  /** opens a TDLib instance (TdRuntime.client) */
  client: () => TdClient;
  app: TelegramApp;
  /** `<configDir>` of the user; the database goes to `<configDir>/telegram/<tdDir>` */
  configDir: string;
  /** per-step wait for TDLib (ms) */
  stepTimeoutMs?: number;
}

/**
 * One login attempt. Methods resolve with the next view; a retryable mistake (wrong code, wrong password, bad phone
 * format) keeps the state and sets `error`. After `done`, `result()` hands over the session secret exactly once.
 */
export class TelegramLogin {
  private td: TdClient | null = null;
  private view: LoginView = { state: "needs_phone" };
  private readonly tdDir = `s-${randomBytes(9).toString("base64url")}`;
  private readonly databaseKey = randomBytes(32).toString("base64");
  private readonly dir: string;
  private outcome: LoginResult | null = null;
  private busy = false;
  private readonly stepMs: number;

  constructor(private readonly o: TelegramLoginOptions) {
    this.dir = join(o.configDir, TELEGRAM_DIR, this.tdDir);
    this.stepMs = o.stepTimeoutMs ?? 20_000;
  }

  get current(): LoginView {
    return { ...this.view };
  }

  /** this attempt's account directory name under `<configDir>/telegram/` (not secret) */
  get directory(): string {
    return this.tdDir;
  }

  /** Opens TDLib for a fresh account directory and waits for "enter phone number". */
  async start(): Promise<LoginView> {
    return this.guard(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const td = this.o.client();
      this.td = td;
      await td.waitAuth((s) => s["@type"] === "authorizationStateWaitTdlibParameters", this.stepMs);
      await td.request(tdlibParameters(this.o.app, this.dir, this.databaseKey), this.stepMs);
      const s = await td.waitAuth((x) => x["@type"] !== "authorizationStateWaitTdlibParameters", this.stepMs);
      if (s["@type"] !== "authorizationStateWaitPhoneNumber") return this.fail("upstream", "텔레그램 로그인을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.");
      return this.set({ state: "needs_phone" });
    });
  }

  async submitPhone(phone: string): Promise<LoginView> {
    return this.guard(async () => {
      if (this.view.state !== "needs_phone" || !this.td) return { ...this.view };
      const e164 = normalizePhone(phone);
      if (!e164) return this.retry({ code: "phone_invalid", message: "전화번호를 다시 확인해 주세요. 예: 010-1234-5678" });
      try {
        await this.td.request({ "@type": "setAuthenticationPhoneNumber", phone_number: e164, settings: null }, this.stepMs);
      } catch (e) {
        return this.tdFail(e, "phone");
      }
      const s = await this.td.waitAuth((x) => x["@type"] !== "authorizationStateWaitPhoneNumber", this.stepMs);
      return this.fromAuth(s, maskPhone(e164));
    });
  }

  async submitCode(code: string): Promise<LoginView> {
    return this.guard(async () => {
      if (this.view.state !== "needs_code" || !this.td) return { ...this.view };
      const clean = String(code ?? "").replace(/[\s-]/g, "");
      if (!/^\d{4,8}$/.test(clean)) return this.retry({ code: "wrong_code", message: "숫자로 된 코드를 입력해 주세요." });
      try {
        await this.td.request({ "@type": "checkAuthenticationCode", code: clean }, this.stepMs);
      } catch (e) {
        return this.tdFail(e, "code");
      }
      const s = await this.td.waitAuth((x) => x["@type"] !== "authorizationStateWaitCode", this.stepMs);
      return this.fromAuth(s, this.view.phoneMasked);
    });
  }

  async submitPassword(password: string): Promise<LoginView> {
    return this.guard(async () => {
      if (this.view.state !== "needs_password" || !this.td) return { ...this.view };
      if (typeof password !== "string" || !password || password.length > 256) return this.retry({ code: "wrong_password", message: "비밀번호를 입력해 주세요." });
      try {
        await this.td.request({ "@type": "checkAuthenticationPassword", password }, this.stepMs);
      } catch (e) {
        return this.tdFail(e, "password");
      }
      const s = await this.td.waitAuth((x) => x["@type"] !== "authorizationStateWaitPassword", this.stepMs);
      return this.fromAuth(s);
    });
  }

  /** The session secret, once, after `done`. */
  result(): LoginResult | null {
    const r = this.outcome;
    this.outcome = null;
    return r;
  }

  /**
   * Ends the attempt. `keepFiles` (after a successful hand-off) only closes TDLib; otherwise the account directory is
   * deleted too (an unfinished login leaves nothing behind).
   */
  async dispose(keepFiles = false): Promise<void> {
    const td = this.td;
    this.td = null;
    this.outcome = null;
    if (td) await td.close().catch(() => {});
    if (!keepFiles) await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }

  async cancel(): Promise<LoginView> {
    if (this.view.state === "done") return this.view;
    this.set({ state: "cancelled", error: { code: "cancelled", message: "로그인을 취소했어요." } });
    await this.dispose(false);
    return this.view;
  }

  // ─────────────── internals ───────────────

  private async fromAuth(s: TdObject, phoneMasked?: string): Promise<LoginView> {
    switch (s["@type"]) {
      case "authorizationStateWaitCode": {
        const info = (s.code_info ?? {}) as { type?: { "@type"?: string; length?: number } };
        const t = info.type ?? {};
        const length = typeof t.length === "number" && t.length > 0 && t.length <= 8 ? t.length : 5;
        return this.set({ state: "needs_code", codeLength: length, codeVia: CODE_VIA[t["@type"] ?? ""] ?? "app", ...(phoneMasked ? { phoneMasked } : {}) });
      }
      case "authorizationStateWaitPassword": {
        const hint = typeof s.password_hint === "string" && s.password_hint.trim() ? clip(s.password_hint.trim(), 40) : undefined;
        return this.set({ state: "needs_password", ...(hint ? { passwordHint: hint } : {}) });
      }
      case "authorizationStateReady":
        return this.finish();
      case "authorizationStateWaitRegistration":
        return this.fail("no_account", "이 번호로 가입된 텔레그램 계정이 없어요. 텔레그램 앱에서 먼저 가입해 주세요.");
      case "authorizationStateWaitEmailAddress":
      case "authorizationStateWaitEmailCode":
        return this.fail("unsupported", "텔레그램이 로그인 이메일 설정을 먼저 요구해요. 텔레그램 앱에서 로그인 이메일을 설정한 뒤 다시 시도해 주세요.");
      case "authorizationStateWaitOtherDeviceConfirmation":
        return this.fail("unsupported", "이 계정은 다른 기기에서 승인하는 로그인을 요구해요. 지금은 지원하지 않아요.");
      default:
        return this.fail("upstream", "텔레그램 로그인을 끝내지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  }

  private async finish(): Promise<LoginView> {
    const td = this.td!;
    let label: string | null = null;
    let userId = "";
    try {
      const me = await td.request<TdObject>({ "@type": "getMe" }, this.stepMs);
      const name = [me.first_name, me.last_name].filter((x) => typeof x === "string" && x).join(" ").trim();
      label = name ? clip(name, 80) : null;
      userId = me.id != null ? String(me.id) : "";
    } catch {
      /* the hub's adapter check fills the label later */
    }
    const secret: Secret = { databaseKey: this.databaseKey, tdDir: this.tdDir };
    this.outcome = { secret, accountLabel: label, meta: userId ? { telegramUserId: userId } : {} };
    // the adapter reopens the same database for the hub's check: TDLib allows one instance per directory
    this.td = null;
    await td.close().catch(() => {});
    return this.set({ state: "done" });
  }

  private tdFail(e: unknown, step: "phone" | "code" | "password"): Promise<LoginView> | LoginView {
    if (!(e instanceof TdError)) return this.fail("network", "텔레그램에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    const m = e.message.toUpperCase();
    const flood = floodSeconds(e);
    if (flood !== null && (e.code === 429 || /FLOOD/.test(m))) return this.fail("flood_wait", floodMessage(flood));
    if (step === "phone") {
      if (/PHONE_NUMBER_INVALID|PHONE_NUMBER_UNOCCUPIED/.test(m)) return this.retry({ code: "phone_invalid", message: "전화번호를 다시 확인해 주세요. 예: 010-1234-5678" });
      if (/PHONE_NUMBER_BANNED/.test(m)) return this.fail("phone_banned", "텔레그램이 이 번호의 로그인을 막았어요. 텔레그램 고객센터에 문의해 주세요.");
      if (/API_ID|APP_VERSION|API_HASH/.test(m)) return this.fail("not_configured", "텔레그램 연결 설정에 문제가 있어요. 운영자에게 알려 주세요.");
    }
    if (step === "code") {
      if (/PHONE_CODE_INVALID|CODE_INVALID/.test(m)) return this.retry({ code: "wrong_code", message: "코드가 맞지 않아요. 텔레그램 앱에 온 코드를 다시 확인해 주세요." });
      if (/PHONE_CODE_EXPIRED|CODE_EXPIRED/.test(m)) return this.fail("code_expired", "코드 유효 시간이 지났어요. 처음부터 다시 시도해 주세요.");
    }
    if (step === "password" && /PASSWORD_HASH_INVALID|PASSWORD_INVALID/.test(m)) {
      return this.retry({ code: "wrong_password", message: "2단계 인증 비밀번호가 맞지 않아요." });
    }
    if (e.code === 408) return this.fail("network", "텔레그램 응답이 늦어요. 잠시 후 다시 시도해 주세요.");
    return this.fail("upstream", "텔레그램 로그인을 끝내지 못했어요. 잠시 후 다시 시도해 주세요.");
  }

  private set(v: LoginView): LoginView {
    this.view = v;
    return { ...v };
  }

  /** keep the state, attach a retryable error */
  private retry(error: NonNullable<LoginView["error"]>): LoginView {
    return this.set({ ...this.view, error });
  }

  private async fail(code: NonNullable<LoginView["error"]>["code"], message: string): Promise<LoginView> {
    this.set({ state: "error", error: { code, message } });
    await this.dispose(false);
    return { ...this.view };
  }

  /** one step at a time; any unexpected throw becomes a terminal error with cleanup */
  private async guard(fn: () => Promise<LoginView>): Promise<LoginView> {
    if (this.busy) return { ...this.view };
    if (TERMINAL.has(this.view.state)) return { ...this.view };
    this.busy = true;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TdError && e.code === 408) return this.fail("network", "텔레그램 응답이 늦어요. 잠시 후 다시 시도해 주세요.");
      return this.fail("upstream", "텔레그램 로그인을 끝내지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      this.busy = false;
    }
  }
}
