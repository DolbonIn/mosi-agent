/**
 * Password reset by the verified phone (onboarding B): a call reads a 6-digit code; verify sets the new password,
 * ends every other session and logs in. Unknown handles and handles without a verified phone look the same.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AuthResponse, PasswordResetStartResponse } from "@pickle/protocol";
import type { Logger, LogFields } from "../src/log.ts";
import { resetMessage, RESET_CALLS_PER_HOUR, RESET_CODE_TTL_MS, RESET_MAX_ATTEMPTS } from "../src/passwordReset.ts";
import { makeDevice, makeHarness, type Harness } from "./helpers.ts";

const TWILIO = { accountSid: "AC123", authToken: "tok", from: "+15550000000" };
const NUMBER = "010-1234-5678";
const LEAKS = ["+821012345678", "821012345678", "01012345678", "010-1234-5678", "12345678"];
const WORDS = ["공", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const NEW_PASSWORD = "new horse battery staple";

describe("POST /api/auth/reset/start + /verify", () => {
  let h: Harness;
  const realFetch = globalThis.fetch;
  let calls: URLSearchParams[] = [];
  let reply: () => Response = () => new Response(JSON.stringify({ sid: "CA1", status: "queued" }), { status: 201 });
  let ip = 0;
  const nextIp = () => `10.9.0.${++ip}`;

  beforeAll(() => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.twilio.com/")) {
        calls.push(new URLSearchParams(String(init?.body)));
        return reply();
      }
      return realFetch(url as string, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(async () => {
    calls = [];
    reply = () => new Response(JSON.stringify({ sid: "CA1", status: "queued" }), { status: 201 });
    await h.close();
  });

  const twimlOf = (p: URLSearchParams) => p.get("Twiml") ?? decodeURIComponent(p.get("Url")!.split("Twiml=")[1]!);
  /** the code read out in the last call: "…인증번호는 삼, 팔, … 입니다." */
  function lastCode(pattern: RegExp): string {
    const m = pattern.exec(twimlOf(calls.at(-1)!))!;
    return m[1]!.split(", ").map((w) => String(WORDS.indexOf(w))).join("");
  }
  const resetCode = () => lastCode(/비밀번호 재설정 인증번호는 ([^<]+) 입니다\./);

  /** signup + register + verify the phone, like 나의 모시 > 내 전화번호 */
  async function userWithPhone(handle = "haneul") {
    const s = await h.signup(handle);
    expect((await h.req("PUT", "/api/profile/phone", { token: s.token, body: { phone: NUMBER } })).status).toBe(200);
    const code = lastCode(/모시 인증번호는 ([^<]+) 입니다\./);
    expect((await h.req("POST", "/api/profile/phone/verify", { token: s.token, body: { code } })).status).toBe(200);
    calls = [];
    return s;
  }
  const start = (handle: string) => h.req("POST", "/api/auth/reset/start", { ip: nextIp(), body: { handle } });
  const verify = async (body: Record<string, unknown>) =>
    h.req("POST", "/api/auth/reset/verify", { ip: nextIp(), body: { password: NEW_PASSWORD, device: await makeDevice(), ...body } });

  function recordLogs(): () => string {
    const lines: string[] = [];
    const rec = (level: string) => (event: string, fields?: LogFields) => void lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
    h.app.core.log = { info: rec("info"), warn: rec("warn"), error: rec("error") } as Logger;
    return () => lines.join("\n");
  }

  test("happy path: call with a 6-digit code → wrong code → right code logs in, ends old sessions, swaps the password", async () => {
    h = await makeHarness({ config: { twilio: TWILIO } });
    const logs = recordLogs();
    const { token: oldToken } = await userWithPhone();

    const res = await start("Haneul ");
    expect(res.status).toBe(200);
    const started = (await res.json()) as PasswordResetStartResponse;
    expect(started).toEqual({ channel: "call", masked: "010-****-5678" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.get("To")).toBe("+821012345678");
    const code = resetCode();
    expect(code).toMatch(/^\d{6}$/);
    const say = `<Say language="ko-KR">${resetMessage(code)}</Say>`;
    expect(twimlOf(calls[0]!)).toBe(`<Response><Pause length="1"/>${say}<Pause length="1"/>${say}</Response>`);

    // a weak password is refused before the code is looked at (no attempt used)
    const weak = await verify({ handle: "haneul", code, password: "short" });
    expect(weak.status).toBe(400);
    expect(await weak.json()).toMatchObject({ error: "weak_password" });

    const wrong = await verify({ handle: "haneul", code: String((Number(code) + 1) % 1_000_000).padStart(6, "0") });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_code", attemptsLeft: RESET_MAX_ATTEMPTS - 1 });

    const ok = await verify({ handle: "haneul", code });
    expect(ok.status).toBe(200);
    const auth = (await ok.json()) as AuthResponse;
    expect(auth.session.user.handle).toBe("haneul");
    expect((await h.req("GET", "/api/session", { token: auth.token })).status).toBe(200);
    expect((await h.req("GET", "/api/session", { token: oldToken })).status).toBe(401); // signed out everywhere else

    const device = await makeDevice();
    const oldLogin = await h.req("POST", "/api/auth/login", { ip: nextIp(), body: { handle: "haneul", password: "correct horse battery", device } });
    expect(oldLogin.status).toBe(401);
    const newLogin = await h.req("POST", "/api/auth/login", { ip: nextIp(), body: { handle: "haneul", password: NEW_PASSWORD, device } });
    expect(newLogin.status).toBe(200);

    // one use only
    const again = await verify({ handle: "haneul", code });
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ error: "code_expired" });

    for (const leak of LEAKS) expect(logs()).not.toContain(leak);
    expect(logs()).not.toContain(code);
  });

  test("unknown handle and no verified phone get the same 409; a registered but unverified phone too", async () => {
    h = await makeHarness({ config: { twilio: TWILIO } });
    await h.signup("jiwoo");
    const unverified = await h.signup("doyun");
    await h.req("PUT", "/api/profile/phone", { token: unverified.token, body: { phone: "010-2222-3333" } });
    calls = [];
    const bodies: unknown[] = [];
    for (const handle of ["nobody", "jiwoo", "doyun", "x", ""]) {
      const r = await start(handle);
      expect([handle, r.status]).toEqual([handle, 409]);
      bodies.push(await r.json());
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ error: "no_verified_phone" });
    expect(calls).toHaveLength(0);
  });

  test("no phone service: 503 before any lookup, for known and unknown handles alike", async () => {
    h = await makeHarness();
    await h.signup("haneul");
    for (const handle of ["haneul", "nobody"]) {
      const r = await start(handle);
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: "phone_unavailable" });
    }
  });

  test("expiry, too many wrong codes, and the hourly call limit", async () => {
    h = await makeHarness({ config: { twilio: TWILIO } });
    await userWithPhone();

    // expired after 10 minutes
    expect((await start("haneul")).status).toBe(200);
    const code1 = resetCode();
    h.clock.t += RESET_CODE_TTL_MS + 1;
    const late = await verify({ handle: "haneul", code: code1 });
    expect(late.status).toBe(410);
    expect(await late.json()).toMatchObject({ error: "code_expired" });

    // 5 wrong codes end the code
    expect((await start("haneul")).status).toBe(200);
    const code2 = resetCode();
    const wrongCode = String((Number(code2) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 1; i <= RESET_MAX_ATTEMPTS; i++) {
      const r = await verify({ handle: "haneul", code: wrongCode });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { attemptsLeft: number }).attemptsLeft).toBe(RESET_MAX_ATTEMPTS - i);
    }
    expect((await verify({ handle: "haneul", code: code2 })).status).toBe(410);

    // 3 calls an hour (two used above)
    expect((await start("haneul")).status).toBe(200);
    expect(calls).toHaveLength(RESET_CALLS_PER_HOUR);
    const limited = await start("haneul");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(calls).toHaveLength(RESET_CALLS_PER_HOUR);
    h.clock.t += 60 * 60_000;
    expect((await start("haneul")).status).toBe(200);
  });

  test("a failed call leaves no usable code", async () => {
    h = await makeHarness({ config: { twilio: TWILIO } });
    await userWithPhone();
    reply = () => new Response(JSON.stringify({ code: 21219, message: "unverified" }), { status: 400 });
    const r = await start("haneul");
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: "phone_failed" });
    const code = resetCode(); // it was read into the TwiML, but the call never went out
    expect((await verify({ handle: "haneul", code })).status).toBe(410);
  });

  test("per-IP auth rate limit applies to reset too", async () => {
    h = await makeHarness({ config: { twilio: TWILIO, authRatePerMinute: 2 } });
    const hit = () => h.req("POST", "/api/auth/reset/start", { ip: "10.8.0.1", body: { handle: "nobody" } });
    expect((await hit()).status).toBe(409);
    expect((await hit()).status).toBe(409);
    const third = await hit();
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: "rate_limited" });
  });
});
