import type { ConnectionVerification, MessengerChat } from "@pickle/protocol";
import type { ChatMessage, ThreadRead } from "../util";

export type Secret = Record<string, string>;
export type Meta = Record<string, unknown>;

/**
 * A live, logged-in provider client. Cached per user+provider and closed when idle.
 * `signal`: the caller (an agent tool) gave up — adapters that can should stop their requests.
 */
export interface Session {
  listChats(opts: { search?: string; limit: number; signal?: AbortSignal }): Promise<MessengerChat[]>;
  readMessages(chatId: string, limit: number, signal?: AbortSignal): Promise<ChatMessage[]>;
  /** messages + room facts (title, kind, members); adapters without extra facts omit it (hub falls back to readMessages) */
  readThread?(chatId: string, limit: number, signal?: AbortSignal): Promise<ThreadRead>;
  /** one chat by id without listing (Slack: the cached list, else conversations.info); null when it has no usable name */
  describeChat?(chatId: string, signal?: AbortSignal): Promise<MessengerChat | null>;
  send(chatId: string, text: string, signal?: AbortSignal): Promise<{ ok: boolean; id?: string }>;
  close(): void | Promise<void>;
}

export interface AdapterCtx {
  userId: string;
  /** `<configRoot>/<userId>` — the only place SDK files for this user may be written */
  configDir: string;
  now(): number;
}

/**
 * Re-opens the user's saved login inside the vault (audited `use()`), for steps that need the
 * password again later, e.g. KakaoTalk device registration finishing in the background.
 */
export type WithLogin = <T>(purpose: string, fn: (secret: Secret) => Promise<T>) => Promise<T>;

export interface Connected {
  kind: "connected";
  /** session secret produced by the login (sealed with `vault.saveSystem`); null → the user's credential IS the session secret (token providers) */
  token: Secret | null;
  /** shown in the UI — never a secret (nickname, masked email, workspace name) */
  accountLabel: string | null;
  /** non-secret connection metadata persisted as JSON (device uuid, team id, …) */
  meta: Meta;
  /** already-open client to cache, if the login produced one */
  session?: Session;
}

export interface Pending {
  kind: "pending";
  verification: ConnectionVerification;
  meta: Meta;
  /** display_code: completes in the background once the user confirms on their phone */
  wait?: (withLogin: WithLogin) => Promise<Connected>;
  /** enter_code: completes with the code the user typed */
  submit?: (code: string, withLogin: WithLogin) => Promise<LoginOutcome>;
}

export type LoginOutcome = Connected | Pending;

export interface ProviderAdapter {
  /** `secret` is the decrypted user credential, or null for device-code/OAuth providers */
  login(ctx: AdapterCtx, secret: Secret | null, meta: Meta): Promise<LoginOutcome>;
  /** opens a session from the session secret (sealed token, or the token credential itself) */
  open(ctx: AdapterCtx, sessionSecret: Secret, meta: Meta): Promise<Session>;
  /** exchanges an expired session secret for a fresh one (all tokens replaced together) */
  refresh?(ctx: AdapterCtx, sessionSecret: Secret, meta: Meta): Promise<Secret>;
  /** true when an error means "the session/token is no longer accepted" */
  isAuthError(err: unknown): boolean;
  /** its sessions implement `describeChat`: the hub names a chat id through it instead of listing every chat */
  describesChats?: boolean;
  /**
   * Sign a session the connection owns out at the provider (e.g. Telegram logOut), so it stops being valid there too:
   * on disconnect (before `cleanup`), and for the previous session when a re-login replaces it (after the new one is
   * live — so it must invalidate ONLY that session, not the account or device). Called inside an audited vault
   * `use()`, best-effort: errors are swallowed and the hub stops waiting after a timeout (then `signal` aborts).
   * Never called for the user's own saved token.
   */
  revoke?(ctx: AdapterCtx, sessionSecret: Secret, meta: Meta, signal: AbortSignal): Promise<void>;
  /** remove provider files under ctx.configDir on disconnect */
  cleanup?(ctx: AdapterCtx): Promise<void>;
}

export function req(secret: Secret | null, ...keys: string[]): string {
  if (!secret) return "";
  for (const k of keys) {
    const v = secret[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
