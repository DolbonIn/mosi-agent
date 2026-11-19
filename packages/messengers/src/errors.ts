/**
 * Errors surfaced by the hub. `message` is always a fixed Korean, user-facing sentence — never
 * an upstream error string (those can echo emails, tokens or server payloads).
 */
export type MessengerErrorCode =
  | "unknown_provider"
  | "provider_unavailable"
  | "invalid_request"
  | "credential_required"
  | "credential_not_found"
  | "credential_expired"
  | "invalid_credential"
  | "bad_credentials"
  | "login_rejected"
  | "two_factor_unsupported"
  | "challenge_required"
  | "verification_failed"
  | "verification_expired"
  | "wrong_code"
  | "no_pending_verification"
  | "not_connected"
  | "session_expired"
  | "chat_not_found"
  | "chat_ambiguous"
  | "network"
  | "rate_limited"
  | "upstream";

export class MessengerError extends Error {
  readonly code: MessengerErrorCode;
  /** chat names to choose from (chat_ambiguous) — safe to show to the model and the user */
  readonly candidates?: string[];
  /** rate_limited: seconds until the provider takes requests again */
  readonly retryAfter?: number;
  constructor(code: MessengerErrorCode, message: string, extra?: { candidates?: string[]; retryAfter?: number }) {
    super(message);
    this.name = "MessengerError";
    this.code = code;
    if (extra?.candidates) this.candidates = extra.candidates;
    if (extra?.retryAfter) this.retryAfter = extra.retryAfter;
  }
}

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" || typeof c === "number" ? String(c) : "";
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "";
}

/** fetch/socket level failures (no response from the provider). */
export function isNetworkError(e: unknown): boolean {
  const code = codeOf(e);
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ConnectionRefused", "refresh_timeout", "refresh_request_failed"].includes(code)) {
    return true;
  }
  const name = (e as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return /fetch failed|network|socket hang up|timed? ?out|ECONN|ENOTFOUND|unable to connect/i.test(messageOf(e));
}

/** Generic "the provider rejected our session" detection (401 / revoked / expired tokens). */
export function looksLikeAuthError(e: unknown): boolean {
  const code = codeOf(e);
  if (
    [
      "invalid_access_token",
      "login_rejected",
      "invalid_auth",
      "not_authed",
      "token_revoked",
      "token_expired",
      "account_inactive",
      "unauthorized",
      "not_authenticated",
      "session_missing",
      "login_required",
      "401",
    ].includes(code)
  ) {
    return true;
  }
  const status = (e as { status?: unknown; statusCode?: unknown } | null);
  if (status?.status === 401 || status?.statusCode === 401) return true;
  return /invalid access token|status -950|\b401\b|unauthori[sz]ed|invalid[_ ]auth|token (has )?expired|login_required/i.test(messageOf(e));
}
