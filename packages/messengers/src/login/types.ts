/**
 * Login drivers: provider-side halves of the login relay (apps/server owns sessions, routes, rate limits and the
 * vault hand-off). A driver turns what the person types (phone, code, password) or does on another device (approve
 * in the Discord app) into a session secret. It never logs, never keeps a typed secret after the call that used it,
 * and cleans up its sockets/files on every terminal path.
 */
import type { Meta, Secret } from "../adapters/types";

export type LoginViewState =
  | "needs_phone"
  | "needs_code"
  | "needs_password"
  | "waiting_scan"
  | "waiting_confirm"
  | "done"
  | "expired"
  | "cancelled"
  | "error";

export type LoginErrorCode =
  | "wrong_code"
  | "wrong_password"
  | "phone_invalid"
  | "phone_banned"
  | "code_expired"
  | "flood_wait"
  | "no_account"
  | "unsupported"
  | "captcha"
  | "qr_rejected"
  | "timeout"
  | "cancelled"
  | "not_configured"
  | "network"
  | "upstream";

export interface LoginView {
  state: LoginViewState;
  /** needs_code: characters to type */
  codeLength?: number;
  /** needs_code: where the provider sent the code */
  codeVia?: "app" | "sms" | "call" | "email";
  /** needs_code: the number the code went to, masked (010-****-1234) */
  phoneMasked?: string;
  /** needs_password: the hint the person set for their own 2FA password (shown by the provider's own apps too) */
  passwordHint?: string;
  /** waiting_scan: https://discord.com/ra/<fingerprint> */
  qrUrl?: string;
  /** waiting_confirm: who scanned (display name only) */
  account?: { name: string };
  /** a retryable answer (wrong_code, wrong_password, phone_invalid) keeps the state and sets this; terminal states always set it */
  error?: { code: LoginErrorCode; message: string };
}

/** What a finished login hands to the hub (vault.saveSystem + adapter check). Never logged, never stored elsewhere. */
export interface LoginResult {
  secret: Secret;
  accountLabel: string | null;
  meta: Meta;
}

export const TERMINAL: ReadonlySet<LoginViewState> = new Set(["done", "expired", "cancelled", "error"]);

/** 010-****-1234 for Korean mobiles, +44 ****1234 otherwise. Input: E.164 ("+821012345678"). */
export function maskPhone(e164: string): string {
  const d = e164.replace(/[^\d]/g, "");
  if (d.startsWith("82") && d.length >= 11) {
    const local = `0${d.slice(2)}`;
    return `${local.slice(0, 3)}-****-${local.slice(-4)}`;
  }
  const last = d.slice(-4);
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : d.slice(0, 1);
  return `+${cc} ****${last}`;
}

/**
 * "010-1234-5678" → "+821012345678" (Korean local numbers), "+1 (415) 555-0100" → "+14155550100", "0044…" → "+44…".
 * Returns null when the result is not a plausible E.164 number.
 */
export function normalizePhone(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw || raw.length > 32) return null;
  let s = raw.replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  else if (/^0\d{8,10}$/.test(s)) s = `+82${s.slice(1)}`;
  else if (/^82\d{8,11}$/.test(s)) s = `+${s}`;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  return s;
}
