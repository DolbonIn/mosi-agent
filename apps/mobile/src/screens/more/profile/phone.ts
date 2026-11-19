import type { ProfileResponse } from "@pickle/protocol";
import { api, toApiError } from "../../../api/client";
import { profileStore, useProfile } from "../../../api/store";

/**
 * 내 전화번호: the one number the agent may call (wake-up and reminder calls). Server contract:
 *   GET    /api/profile                → phone: { masked, verified } | null
 *   PUT    /api/profile/phone {phone}  → { masked, verified:false } and the server places a call that reads a 4-digit code
 *   POST   /api/profile/phone/verify {code} → { masked, verified:true }
 *   DELETE /api/profile/phone          → { ok:true }
 * The row and the sheet read the phone from the profile store; every mutation writes the server's answer back into it.
 */

export interface PhoneInfo {
  masked: string;
  verified: boolean;
}

type WithPhone = ProfileResponse & { phone?: PhoneInfo | null };

/** undefined while the profile has not loaded; null when no number is registered */
export function usePhone(): PhoneInfo | null | undefined {
  const data = useProfile().data as WithPhone | null;
  return data ? (data.phone ?? null) : undefined;
}

function storePhone(phone: PhoneInfo | null) {
  const s = profileStore.get();
  if (s.data) profileStore.set({ ...s, data: { ...s.data, phone } as WithPhone });
}

/** "다시 걸기" stays off this long after a call went out */
export const RESEND_MS = 30_000;

/** The number typed this session and when its verification call went out: survives closing and reopening the sheet. */
let pending: { number: string; masked: string; sentAt: number } | null = null;
export const getPending = () => pending;

/** what the server gets: digits, with a leading + kept for international numbers */
const normalize = (v: string) => {
  const t = v.trim();
  return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, "");
};

/** at least 9 digits before we ask the server (02-123-4567 is the shortest Korean number) */
export const looksDialable = (v: string) => v.replace(/\D/g, "").length >= 9;

/** Groups Korean numbers as they are typed (010-1234-5678, 02-123-4567); +international input is left as typed. */
export function formatPhoneInput(raw: string): string {
  const t = raw.trimStart();
  if (t.startsWith("+")) return "+" + t.slice(1).replace(/[^\d -]/g, "").slice(0, 18);
  const d = t.replace(/\D/g, "").slice(0, 11);
  if (d.startsWith("02")) {
    if (d.length <= 2) return d;
    if (d.length <= 5) return `${d.slice(0, 2)}-${d.slice(2)}`;
    if (d.length <= 9) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
    return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}`;
  }
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

/**
 * PUT: the server answers once it has placed the verification call. It synthesizes the voice and dials before
 * answering (its own limit is 120 s), so this request outlives the client's default 15 s timeout.
 */
export async function requestCall(number: string): Promise<PhoneInfo> {
  const r = await api<PhoneInfo>("PUT", "/api/profile/phone", { phone: normalize(number) }, { timeoutMs: 125_000 });
  pending = { number, masked: r.masked, sentAt: Date.now() };
  storePhone({ masked: r.masked, verified: false });
  return r;
}

export async function confirmCode(code: string): Promise<PhoneInfo> {
  const r = await api<PhoneInfo>("POST", "/api/profile/phone/verify", { code });
  if (!r || r.verified !== true) throw new Error("not_verified");
  pending = null;
  storePhone({ masked: r.masked, verified: true });
  return r;
}

export async function removePhone(): Promise<void> {
  await api<{ ok: true }>("DELETE", "/api/profile/phone");
  pending = null;
  storePhone(null);
}

/** attemptsLeft rides on the error body (ApiError.data once the client keeps it) */
function attemptsLeft(e: unknown): number | null {
  const data = (e as { data?: { attemptsLeft?: unknown } } | null)?.data;
  return typeof data?.attemptsLeft === "number" ? data.attemptsLeft : null;
}

/** Korean copy at the field, per step ("call" = asking for the call, "verify" = typing the code) */
export function phoneErrorMessage(e: unknown, step: "call" | "verify"): string {
  if (e instanceof Error && e.message === "not_verified") return "인증을 끝내지 못했어요. 다시 걸기로 새 숫자를 받아 주세요.";
  const err = toApiError(e);
  switch (err.code) {
    case "invalid_phone":
      return "번호 형식이 맞지 않아요. 휴대폰 번호를 다시 확인해 주세요.";
    case "phone_unavailable":
      return "지금은 인증 전화를 걸 수 없어요. 잠시 후 다시 시도해 주세요.";
    case "phone_failed":
      return "인증 전화를 걸지 못했어요. 번호를 확인하고 잠시 후 다시 시도해 주세요.";
    case "rate_limited":
      return step === "call" ? "인증 전화를 너무 자주 요청했어요. 잠시 후 다시 시도해 주세요." : "너무 여러 번 입력했어요. 잠시 후 다시 걸기로 새 숫자를 받아 주세요.";
    case "bad_code": {
      const n = attemptsLeft(err);
      if (n === null) return "숫자가 맞지 않아요. 다시 입력해 주세요.";
      return n > 0 ? `숫자가 맞지 않아요. ${n}번 더 입력할 수 있어요.` : "숫자가 맞지 않아요. 다시 걸기로 새 숫자를 받아 주세요.";
    }
    case "expired":
      return "입력 시간이 지났어요. 다시 걸기로 새 숫자를 받아 주세요.";
    default:
      return err.message;
  }
}
