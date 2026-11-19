/**
 * 나의 모시 > 내 전화번호: register the user's own phone and verify it with a call that reads a 4-digit
 * code twice (same dial path as the phone tools: TTS `<Play>` when available, `<Say>` otherwise, trial
 * fallbacks). A verified number unlocks `sys_call_me`.
 *  - PUT    /api/profile/phone {phone}        → {masked, verified:false} (places the verification call)
 *  - POST   /api/profile/phone/verify {code}  → {masked, verified:true}
 *  - DELETE /api/profile/phone                → {ok:true}
 * Limits: 3 verification calls per user per hour (kept across DELETE), code valid 10 min, 5 attempts.
 * The number is never logged and never returned unmasked.
 */
import type { Core } from "./core.ts";
import { bad, HttpError, json, readJson, type Ctx } from "./http.ts";
import { errInfo } from "./log.ts";
import { dial, maskPhone, myPhoneView, normalizePhone, readMyPhone, writeMyPhone } from "./phone.ts";
import { safeJson, sha256Hex, timingSafeEqualStr } from "./util.ts";

export const VERIFY_CALLS_PER_HOUR = 3;
export const VERIFY_CODE_TTL_MS = 10 * 60_000;
export const VERIFY_MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60_000;
const CALLS_KEY = "sys:phone_verify_calls";

const KOREAN_DIGITS = ["공", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];

/** "삼, 팔, 일, 오": digits as Korean words so every voice reads them the same way */
export function spokenDigits(code: string): string {
  return [...code].map((d) => KOREAN_DIGITS[Number(d)]).join(", ");
}

/** "모시 인증번호는 삼, 팔, 일, 오 입니다." */
export function verificationMessage(code: string): string {
  return `모시 인증번호는 ${spokenDigits(code)} 입니다.`;
}

function newCode(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0]! % 10_000).padStart(4, "0");
}

const codeHash = (userId: string, code: string) => sha256Hex(`${userId}:${code}`);

export function myPhoneRoutes(core: Core) {
  const unavailable = () => new HttpError(503, "phone_unavailable", "전화 연결 서비스가 아직 준비되지 않았어요");

  /** recent verification calls (epoch ms), newest last; survives DELETE so re-registering can't bypass the limit */
  const recentCalls = (userId: string): number[] => {
    const now = core.now();
    const v = safeJson<unknown>(core.db.kvGet(userId, CALLS_KEY), []);
    return Array.isArray(v) ? v.filter((t): t is number => typeof t === "number" && now - t < HOUR_MS) : [];
  };

  return {
    register: async (c: Ctx, userId: string): Promise<Response> => {
      if (!core.cfg.twilio) throw unavailable();
      const body = await readJson(c.req);
      const e164 = typeof body.phone === "string" ? normalizePhone(body.phone) : null;
      if (!e164) throw bad("전화번호 형식이 올바르지 않아요. 010-1234-5678처럼 입력해 주세요", "invalid_phone");
      const now = core.now();
      const calls = recentCalls(userId);
      if (calls.length >= VERIFY_CALLS_PER_HOUR) {
        const retry = Math.max(1, Math.ceil((calls[0]! + HOUR_MS - now) / 1000));
        throw new HttpError(429, "rate_limited", "인증 전화를 너무 자주 요청했어요. 잠시 후 다시 시도해 주세요.", { "Retry-After": String(retry) });
      }
      core.db.kvSet(userId, CALLS_KEY, JSON.stringify([...calls, now]), now);

      const prev = readMyPhone(core, userId);
      const code = newCode();
      writeMyPhone(core, userId, { e164, verifiedAt: null, codeHash: codeHash(userId, code), codeExpiresAt: now + VERIFY_CODE_TTL_MS, attempts: 0 });
      // not tied to the request: a client that leaves mid-synthesis still gets its call
      const r = await dial(core, { to: e164, message: verificationMessage(code), repeat: true, signal: AbortSignal.timeout(120_000) });
      if (!r.ok) {
        writeMyPhone(core, userId, prev); // the code never reached the phone: keep what the user had
        core.log.warn("phone verification call failed", { user: userId, error: r.error });
        if (r.error === "phone_not_configured") throw unavailable();
        throw new HttpError(502, "phone_failed", "인증 전화를 걸지 못했어요. 번호를 확인하고 잠시 후 다시 시도해 주세요");
      }
      core.log.info("phone verification call", { user: userId });
      return json({ masked: maskPhone(e164), verified: false });
    },

    verify: async (c: Ctx, userId: string): Promise<Response> => {
      const body = await readJson(c.req);
      const rec = readMyPhone(core, userId);
      if (rec && rec.verifiedAt !== null && !rec.codeHash) return json(myPhoneView(rec));
      const expired = () => new HttpError(410, "expired", "인증번호가 만료됐어요. 인증 전화를 다시 받아 주세요");
      if (!rec || !rec.codeHash) throw expired();
      if (rec.codeExpiresAt <= core.now()) {
        writeMyPhone(core, userId, { ...rec, codeHash: null });
        throw expired();
      }
      if (rec.attempts >= VERIFY_MAX_ATTEMPTS) {
        throw new HttpError(429, "rate_limited", "인증번호를 너무 많이 틀렸어요. 인증 전화를 다시 받아 주세요");
      }
      const code = typeof body.code === "string" || typeof body.code === "number" ? String(body.code).replace(/\D/g, "") : "";
      if (code.length === 4 && timingSafeEqualStr(codeHash(userId, code), rec.codeHash)) {
        const next = { ...rec, verifiedAt: core.now(), codeHash: null, attempts: 0 };
        writeMyPhone(core, userId, next);
        core.log.info("phone verified", { user: userId });
        return json(myPhoneView(next));
      }
      const attempts = rec.attempts + 1;
      writeMyPhone(core, userId, { ...rec, attempts });
      const attemptsLeft = Math.max(0, VERIFY_MAX_ATTEMPTS - attempts);
      return json({ error: "bad_code", message: attemptsLeft ? `인증번호가 맞지 않아요 (${attemptsLeft}번 남음)` : "인증번호가 맞지 않아요. 인증 전화를 다시 받아 주세요", attemptsLeft }, 400);
    },

    remove: async (_c: Ctx, userId: string): Promise<Response> => {
      writeMyPhone(core, userId, null);
      core.log.info("phone removed", { user: userId });
      return json({ ok: true });
    },
  };
}

/** For GET /api/profile. */
export function profilePhone(core: Core, userId: string): { masked: string; verified: boolean } | null {
  try {
    return myPhoneView(readMyPhone(core, userId));
  } catch (err) {
    core.log.warn("profile phone unreadable", { err: errInfo(err) });
    return null;
  }
}
