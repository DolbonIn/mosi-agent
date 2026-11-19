/**
 * Password reset by the verified phone (onboarding B): the number the user verified in 나의 모시 > 내 전화번호 gets a
 * call that reads a 6-digit code twice (the same dial path as the verification call). There is no SMS path.
 *  - POST /api/auth/reset/start  {handle}                         → {channel:"call", masked}
 *  - POST /api/auth/reset/verify {handle, code, password, device} → AuthResponse (logged in; other sessions end)
 * An unknown handle and a handle without a verified phone get the same 409 `no_verified_phone`, and the Twilio check
 * comes before the lookup, so a missing phone service says nothing about who exists. Limits: the auth per-IP rate,
 * 3 reset calls per user per hour, code valid 10 min, 5 attempts. The number is never logged and never returned
 * unmasked; the code is stored hashed.
 */
import type { AuthResponse } from "@pickle/protocol";
import type { Core } from "./core.ts";
import { bootstrap, defaultSkillIds, hashPassword, HANDLE_RE, issueSession, parseDevice, RateLimiter } from "./auth.ts";
import { bad, HttpError, json, readJson, type Ctx } from "./http.ts";
import { errInfo } from "./log.ts";
import { spokenDigits } from "./myphone.ts";
import { dial, maskPhone, readMyPhone } from "./phone.ts";
import { safeJson, sha256Hex, timingSafeEqualStr } from "./util.ts";

export const RESET_CALLS_PER_HOUR = 3;
export const RESET_CODE_TTL_MS = 10 * 60_000;
export const RESET_MAX_ATTEMPTS = 5;
export const RESET_CODE_DIGITS = 6;
const HOUR_MS = 60 * 60_000;
const STATE_KEY = "sys:pw_reset";
const CALLS_KEY = "sys:pw_reset_calls";

/** "모시 비밀번호 재설정 인증번호는 삼, 팔, … 입니다. 요청하지 않았다면 이 전화는 무시해 주세요." */
export function resetMessage(code: string): string {
  return `모시 비밀번호 재설정 인증번호는 ${spokenDigits(code)} 입니다. 요청하지 않았다면 이 전화는 무시해 주세요.`;
}

interface ResetState {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

const resetHash = (userId: string, code: string) => sha256Hex(`reset:${userId}:${code}`);

function newCode(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0]! % 10 ** RESET_CODE_DIGITS).padStart(RESET_CODE_DIGITS, "0");
}

export function passwordResetRoutes(core: Core) {
  const limiter = new RateLimiter(core.cfg.authRatePerMinute, 60_000, core.now);
  const limit = (c: Ctx) => {
    if (!limiter.hit(c.ip)) {
      throw new HttpError(429, "rate_limited", "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.", { "Retry-After": String(limiter.retryAfter(c.ip)) });
    }
  };
  const handleOf = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const userOf = (handle: string) => (HANDLE_RE.test(handle) ? core.db.userByHandle(handle) : null);

  const readState = (userId: string): ResetState | null => {
    const v = safeJson<Partial<ResetState> | null>(core.db.kvGet(userId, STATE_KEY), null);
    return v && typeof v.codeHash === "string" && typeof v.expiresAt === "number"
      ? { codeHash: v.codeHash, expiresAt: v.expiresAt, attempts: typeof v.attempts === "number" ? v.attempts : 0 }
      : null;
  };
  const writeState = (userId: string, s: ResetState | null) => core.db.kvSet(userId, STATE_KEY, s ? JSON.stringify(s) : "", core.now());

  const recentCalls = (userId: string): number[] => {
    const now = core.now();
    const v = safeJson<unknown>(core.db.kvGet(userId, CALLS_KEY), []);
    return Array.isArray(v) ? v.filter((t): t is number => typeof t === "number" && now - t < HOUR_MS) : [];
  };

  return {
    start: async (c: Ctx): Promise<Response> => {
      limit(c);
      const body = await readJson(c.req);
      if (!core.cfg.twilio) throw new HttpError(503, "phone_unavailable", "전화 연결 서비스가 아직 준비되지 않았어요");
      const user = userOf(handleOf(body.handle));
      const phone = user ? readMyPhone(core, user.id) : null;
      if (!user || !phone || phone.verifiedAt === null) {
        throw new HttpError(409, "no_verified_phone", "이 아이디로 인증한 전화번호를 찾지 못했어요. 아이디를 확인해 주세요.");
      }
      const now = core.now();
      const calls = recentCalls(user.id);
      if (calls.length >= RESET_CALLS_PER_HOUR) {
        const retry = Math.max(1, Math.ceil((calls[0]! + HOUR_MS - now) / 1000));
        throw new HttpError(429, "rate_limited", "인증 전화를 너무 자주 요청했어요. 잠시 후 다시 시도해 주세요.", { "Retry-After": String(retry) });
      }
      core.db.kvSet(user.id, CALLS_KEY, JSON.stringify([...calls, now]), now);
      const code = newCode();
      writeState(user.id, { codeHash: resetHash(user.id, code), expiresAt: now + RESET_CODE_TTL_MS, attempts: 0 });
      // not tied to the request: a client that leaves mid-synthesis still gets its call
      const r = await dial(core, { to: phone.e164, message: resetMessage(code), repeat: true, signal: AbortSignal.timeout(120_000) });
      if (!r.ok) {
        writeState(user.id, null); // the code never reached the phone
        core.log.warn("password reset call failed", { user: user.id, error: r.error });
        if (r.error === "phone_not_configured") throw new HttpError(503, "phone_unavailable", "전화 연결 서비스가 아직 준비되지 않았어요");
        throw new HttpError(502, "phone_failed", "인증 전화를 걸지 못했어요. 잠시 후 다시 시도해 주세요");
      }
      core.log.info("password reset call", { user: user.id });
      return json({ channel: "call", masked: maskPhone(phone.e164) });
    },

    verify: async (c: Ctx): Promise<Response> => {
      limit(c);
      const body = await readJson(c.req);
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 8) throw bad("비밀번호는 8자 이상이어야 해요", "weak_password");
      if (password.length > 128) throw bad("비밀번호가 너무 길어요", "invalid_password");
      const device = parseDevice(body.device);
      const expired = () => new HttpError(410, "code_expired", "인증번호가 만료됐어요. 인증 전화를 다시 받아 주세요");
      const user = userOf(handleOf(body.handle));
      const state = user ? readState(user.id) : null;
      if (!user || !state) throw expired();
      if (state.expiresAt <= core.now()) {
        writeState(user.id, null);
        throw expired();
      }
      const code = typeof body.code === "string" || typeof body.code === "number" ? String(body.code).replace(/\D/g, "") : "";
      if (code.length === RESET_CODE_DIGITS && timingSafeEqualStr(resetHash(user.id, code), state.codeHash)) {
        writeState(user.id, null); // one use, before the first await
        const passwordHash = await hashPassword(core, password);
        const now = core.now();
        core.db.setPasswordHash(user.id, passwordHash);
        core.db.deleteUserSessions(user.id); // whoever knew the old password is signed out everywhere
        core.db.upsertDevice(user.id, device, now);
        try {
          if (!(await core.deps.launcher.profile(user.id)))
            await core.deps.launcher.provision(user.id, { agentName: user.agent_name, displayName: user.display_name, enabledSkills: defaultSkillIds(core) });
        } catch (err) {
          core.log.warn("reset provision check failed", { user: user.id, err: errInfo(err) });
        }
        const token = issueSession(core, user.id, device.id);
        core.log.info("password reset", { user: user.id });
        const res: AuthResponse = { token, session: await bootstrap(core, core.db.userById(user.id)!) };
        return json(res);
      }
      const attempts = state.attempts + 1;
      const attemptsLeft = Math.max(0, RESET_MAX_ATTEMPTS - attempts);
      writeState(user.id, attemptsLeft ? { ...state, attempts } : null);
      return json(
        {
          error: "invalid_code",
          message: attemptsLeft ? `인증번호가 맞지 않아요 (${attemptsLeft}번 남음)` : "인증번호가 맞지 않아요. 인증 전화를 다시 받아 주세요",
          attemptsLeft,
        },
        400,
      );
    },
  };
}
