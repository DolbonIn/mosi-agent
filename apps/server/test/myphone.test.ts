import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ProfileResponse, Thread } from "@pickle/protocol";
import type { ToolContext, ToolDef } from "@pickle/agent";
import { buildTools } from "../src/turns.ts";
import { callMeTool, CALL_ME_DAILY_LIMIT, phoneTools } from "../src/phone.ts";
import { verificationMessage } from "../src/myphone.ts";
import { kstToEpoch } from "../src/kst.ts";
import type { Logger, LogFields } from "../src/log.ts";
import { makeHarness, outcome, type Harness } from "./helpers.ts";

const TWILIO = { accountSid: "AC123", authToken: "tok", from: "+15550000000" };
const NUMBER = "010-1234-5678";
const E164 = "+821012345678";
/** every spelling of the test number that must never leak */
const LEAKS = ["+821012345678", "821012345678", "01012345678", "1012345678", "010-1234-5678", "+8201012345678", "12345678"];
const WORDS = ["공", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];

function ctxFor(userId: string, statuses: string[] = []): ToolContext {
  return {
    userId,
    threadId: "t_x",
    agentName: "깽이",
    displayName: "하늘",
    workspaceDir: "/tmp",
    signal: new AbortController().signal,
    credentials: { find: async () => null, use: async () => Promise.reject(new Error("no")) },
    store: {} as ToolContext["store"],
    status: (s) => statuses.push(s),
    now: () => new Date(),
  };
}

/** structured logs + raw console output, to prove the number never appears */
function recordLogs(h: Harness): { text(): string; restore(): void } {
  const lines: string[] = [];
  const rec = (level: string) => (event: string, fields?: LogFields) => lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
  const logger: Logger = { info: rec("info"), warn: rec("warn"), error: rec("error") };
  h.app.core.log = logger;
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void lines.push(`console.${k} ${a.map(String).join(" ")}`);
  return {
    text: () => lines.join("\n"),
    restore: () => Object.assign(console, orig),
  };
}

describe("내 전화번호 + sys_call_me", () => {
  let h: Harness;
  const realFetch = globalThis.fetch;
  let calls: URLSearchParams[] = [];
  let reply: (p: URLSearchParams) => Response = () => new Response(JSON.stringify({ sid: "CA1", status: "queued" }), { status: 201 });

  beforeAll(() => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.twilio.com/")) {
        const p = new URLSearchParams(String(init?.body));
        calls.push(p);
        return reply(p);
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

  /** the 4-digit code read out in the last verification call (<Say> mode) */
  function lastCode(): string {
    const twiml = (calls.at(-1)!.get("Twiml") ?? decodeURIComponent(calls.at(-1)!.get("Url")!.split("Twiml=")[1]!))!;
    const m = /모시 인증번호는 ([^<]+) 입니다\./.exec(twiml)!;
    return m[1]!.split(", ").map((w) => String(WORDS.indexOf(w))).join("");
  }

  async function register(token: string, phone = NUMBER) {
    return h.req("PUT", "/api/profile/phone", { token, body: { phone } });
  }
  const profilePhone = async (token: string) => ((await (await h.req("GET", "/api/profile", { token })).json()) as ProfileResponse).phone;

  test("register → verify (wrong, then right) → sys_call_me dials the stored number; nothing leaks", async () => {
    h = await makeHarness({ config: { twilio: TWILIO } });
    const logs = recordLogs(h);
    try {
      const { token, session } = await h.signup("haneul");
      expect(await profilePhone(token)).toBeNull();

      const reg = await register(token);
      expect(reg.status).toBe(200);
      expect(await reg.json()).toEqual({ masked: "010-****-5678", verified: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.get("To")).toBe(E164);
      const code = lastCode();
      expect(code).toMatch(/^\d{4}$/);
      const say = `<Say language="ko-KR">${verificationMessage(code)}</Say>`;
      expect(calls[0]!.get("Twiml")).toBe(`<Response><Pause length="1"/>${say}<Pause length="1"/>${say}</Response>`);
      expect(await profilePhone(token)).toEqual({ masked: "010-****-5678", verified: false });

      // not verified yet → sys_call_me refuses
      const early = await callMeTool(h.app.core).run({ message: "일어나세요" }, ctxFor(session.user.id));
      expect(early).toMatchObject({ ok: false, summary: "먼저 나의 모시 > 내 전화번호를 등록하고 인증해 주세요" });

      const wrong = String((Number(code) + 1) % 10_000).padStart(4, "0");
      const bad = await h.req("POST", "/api/profile/phone/verify", { token, body: { code: wrong } });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "bad_code", attemptsLeft: 4 });
      const ok = await h.req("POST", "/api/profile/phone/verify", { token, body: { code } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ masked: "010-****-5678", verified: true });
      expect(await profilePhone(token)).toEqual({ masked: "010-****-5678", verified: true });

      const statuses: string[] = [];
      const r = await callMeTool(h.app.core).run({ message: "좋은 아침이에요. 일어날 시간이에요." }, ctxFor(session.user.id, statuses));
      expect(r).toMatchObject({ ok: true, summary: "내 휴대폰으로 전화를 걸었어요", data: { status: "queued", to: "010-****-5678" } });
      expect(calls).toHaveLength(2);
      expect(calls[1]!.get("To")).toBe(E164);
      expect(calls[1]!.get("Twiml")).toBe('<Response><Say language="ko-KR">좋은 아침이에요. 일어날 시간이에요.</Say></Response>');
      const threads = (await (await h.req("GET", "/api/threads", { token })).json()) as Thread[];
      expect(threads.find((t) => t.kind === "call")).toMatchObject({ title: "내 휴대폰으로 전화", subtitle: "깽이의 외부 통화", unread: true });

      // the number never reaches tool results, the profile, thread notes or logs
      const visible = JSON.stringify([r, early, await (await h.req("GET", "/api/profile", { token })).json(), threads]);
      const notes = JSON.stringify(await (await h.req("GET", `/api/threads/${threads.find((t) => t.kind === "call")!.id}/messages`, { token })).json());
      for (const leak of LEAKS) {
        expect(visible).not.toContain(leak);
        expect(notes).not.toContain(leak);
        expect(logs.text()).not.toContain(leak);
      }
      expect(notes).toContain("내 휴대폰(010-****-5678)으로 전화를 걸었어요");
      expect(logs.text()).not.toContain(verificationMessage(code));
      expect(logs.text()).not.toContain("인증번호");
    } finally {
      logs.restore();
    }
  });

  test("sys_call_me plays 모시's voice when TTS and public audio are ready; digits work too", async () => {
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/tts"
          ? new Response("ID3fake", { headers: { "Content-Type": "audio/mpeg", "X-Audio-Duration": "1" } })
          : Response.json({ ok: true, ready: true }),
    });
    try {
      h = await makeHarness({ config: { twilio: TWILIO, tts: { url: `http://127.0.0.1:${fake.port}` } } });
      h.app.core.voice.setPublicBase("https://audio.example.test");
      const { token, session } = await h.signup("haneul");
      await register(token);
      const play = /<Play>https:\/\/audio\.example\.test\/a\/[0-9a-f]{32}\.mp3<\/Play>/;
      // the verification call itself uses <Play>, code read twice
      expect(calls[0]!.get("Twiml")).toMatch(new RegExp(`^<Response><Pause length="1"/>${play.source}<Pause length="1"/>${play.source}</Response>$`));
      // verify through the stored record (the code is only in the audio here)
      const { readMyPhone, writeMyPhone } = await import("../src/phone.ts");
      writeMyPhone(h.app.core, session.user.id, { ...readMyPhone(h.app.core, session.user.id)!, verifiedAt: h.clock.t, codeHash: null });
      const r = await callMeTool(h.app.core).run({ message: "회의 시작해요", digits: "1234#" }, ctxFor(session.user.id));
      expect(r.ok).toBe(true);
      const twiml = calls[1]!.get("Twiml")!;
      expect(twiml).toMatch(new RegExp(`^<Response><Pause length="4"/><Play digits="1234#"/><Pause length="5"/>${play.source}<Pause length="1"/>${play.source}</Response>$`));
    } finally {
      fake.stop(true);
    }
  });

  test("trial fallbacks apply to the verification call (Echo twimlet, +82 0…)", async () => {
    h = await makeHarness({ config: { twilio: TWILIO } });
    const { token } = await h.signup("haneul");
    reply = (p) => {
      if (p.has("Twiml")) return new Response(JSON.stringify({ code: 0 }), { status: 400 });
      if (p.get("To") === E164) return new Response(JSON.stringify({ code: 573002 }), { status: 422 });
      return new Response(JSON.stringify({ sid: "CA9", status: "queued" }), { status: 201 });
    };
    expect((await register(token)).status).toBe(200);
    expect(calls.map((c) => [c.get("To"), c.has("Twiml") ? "twiml" : "url"])).toEqual([
      [E164, "twiml"],
      [E164, "url"],
      ["+8201012345678", "url"],
    ]);
    expect(calls[2]!.get("Url")).toStartWith("https://twimlets.com/echo?Twiml=");
    const code = lastCode();
    expect((await h.req("POST", "/api/profile/phone/verify", { token, body: { code } })).status).toBe(200);
  });

  test("register errors: 503 without Twilio, 400 invalid, 429 after 3 calls an hour (DELETE doesn't reset), 502 keeps the old number", async () => {
    h = await makeHarness();
    const a = await h.signup("haneul");
    const off = await register(a.token);
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: "phone_unavailable" });
    await h.close();

    h = await makeHarness({ config: { twilio: TWILIO } });
    const { token } = await h.signup("haneul");
    for (const phone of ["12", "abc", "", "010-1234"]) {
      const r = await register(token, phone);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("invalid_phone");
    }
    expect((await h.req("PUT", "/api/profile/phone", { token, body: {} })).status).toBe(400);
    expect(calls).toHaveLength(0);

    expect((await register(token)).status).toBe(200);
    await h.req("POST", "/api/profile/phone/verify", { token, body: { code: lastCode() } });
    expect((await register(token, "010-2222-3333")).status).toBe(200);
    expect((await h.req("DELETE", "/api/profile/phone", { token })).status).toBe(200);
    expect((await register(token)).status).toBe(200);
    const limited = await register(token);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(calls).toHaveLength(3);

    // an hour later: allowed again; a failed call restores what the user had
    h.clock.t += 60 * 60_000;
    expect((await register(token)).status).toBe(200);
    expect((await h.req("POST", "/api/profile/phone/verify", { token, body: { code: lastCode() } })).status).toBe(200);
    expect(await profilePhone(token)).toEqual({ masked: "010-****-5678", verified: true });
    reply = () => new Response(JSON.stringify({ code: 21219, message: "unverified" }), { status: 400 });
    const failed = await register(token, "010-9999-8888");
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: "phone_failed" });
    expect(await profilePhone(token)).toEqual({ masked: "010-****-5678", verified: true });
  });

  test("verify errors: 410 when expired or nothing pending, 429 after 5 wrong attempts", async () => {
    h = await makeHarness({ config: { twilio: TWILIO } });
    const { token } = await h.signup("haneul");
    const none = await h.req("POST", "/api/profile/phone/verify", { token, body: { code: "1234" } });
    expect(none.status).toBe(410);
    expect(await none.json()).toMatchObject({ error: "expired" });

    await register(token);
    const code = lastCode();
    h.clock.t += 10 * 60_000;
    const late = await h.req("POST", "/api/profile/phone/verify", { token, body: { code } });
    expect(late.status).toBe(410);
    expect(await late.json()).toMatchObject({ error: "expired" });

    await register(token);
    const fresh = lastCode();
    const wrong2 = String((Number(fresh) + 1) % 10_000).padStart(4, "0");
    const left: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await h.req("POST", "/api/profile/phone/verify", { token, body: { code: i === 2 ? "12" : wrong2 } });
      expect(r.status).toBe(400);
      left.push(((await r.json()) as { attemptsLeft: number }).attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    const locked = await h.req("POST", "/api/profile/phone/verify", { token, body: { code: fresh } });
    expect(locked.status).toBe(429);
    expect(await profilePhone(token)).toEqual({ masked: "010-****-5678", verified: false });
  });

  test("daily cap: 10 calls a KST day, then refused until the next day; DELETE clears the number", async () => {
    h = await makeHarness({ config: { twilio: TWILIO } });
    const { token, session } = await h.signup("haneul");
    await register(token);
    await h.req("POST", "/api/profile/phone/verify", { token, body: { code: lastCode() } });
    const tool = callMeTool(h.app.core);
    for (let i = 0; i < CALL_ME_DAILY_LIMIT; i++) expect((await tool.run({ message: `알림 ${i}` }, ctxFor(session.user.id))).ok).toBe(true);
    const capped = await tool.run({ message: "한 번 더" }, ctxFor(session.user.id));
    expect(capped).toMatchObject({ ok: false, data: { error: "daily_limit" } });
    expect(calls).toHaveLength(1 + CALL_ME_DAILY_LIMIT);

    h.clock.t = kstToEpoch(2026, 11, 12, 0, 1); // next KST day
    expect((await tool.run({ message: "새 날" }, ctxFor(session.user.id))).ok).toBe(true);

    const del = await h.req("DELETE", "/api/profile/phone", { token });
    expect(await del.json()).toEqual({ ok: true });
    expect(await profilePhone(token)).toBeNull();
    const after = await tool.run({ message: "지워졌나요" }, ctxFor(session.user.id));
    expect(after).toMatchObject({ ok: false, data: { error: "phone_not_verified" } });
    expect((await tool.run({ message: "" }, ctxFor(session.user.id))).ok).toBe(false);
  });

  test("tool list: sys_call_me is not approval-gated, sys_phone_call is; neither in friend threads", async () => {
    h = await makeHarness({ config: { twilio: TWILIO } });
    const [phone, me] = phoneTools(h.app.core) as ToolDef[];
    expect(phone!.name).toBe("sys_phone_call");
    expect(typeof phone!.approval).toBe("function");
    expect(me!.name).toBe("sys_call_me");
    expect(me!.approval).toBeUndefined();
    expect(me!.description).toContain("sys_phone_call");
    expect(buildTools(h.app.core, "task", undefined).map((t) => t.name)).toEqual(expect.arrayContaining(["sys_phone_call", "sys_call_me"]));
    expect(buildTools(h.app.core, "friend", undefined).map((t) => t.name)).not.toContain("sys_call_me");
  });

  test("a scheduled wake-up turn (nobody to approve) calls the user's own phone", async () => {
    h = await makeHarness({ config: { twilio: TWILIO, schedulerIntervalMs: 999_999 } });
    const { token, session } = await h.signup("haneul");
    await register(token);
    await h.req("POST", "/api/profile/phone/verify", { token, body: { code: lastCode() } });
    h.turns.set(async (input) => {
      await input.ctx.store.createSchedule({ title: "모닝콜", prompt: "전화로 깨워줘", rule: "daily@07:00" });
      return outcome("매일 아침 7시에 전화로 깨워 드릴게요");
    });
    const { readSse } = await import("./helpers.ts");
    await readSse(await h.req("POST", `/api/threads/${session.mainThreadId}/messages`, { token, body: { text: "매일 7시에 전화로 깨워줘" } }));

    h.clock.t = kstToEpoch(2026, 11, 12, 7, 0);
    let result: unknown = null;
    h.turns.set(async (input) => {
      const tool = input.tools.find((t) => t.name === "sys_call_me")!;
      expect(tool.approval).toBeUndefined();
      result = await tool.run({ message: "좋은 아침이에요! 일어날 시간이에요." }, input.ctx);
      return outcome("깨워 드렸어요");
    });
    expect(await h.app.scheduler.tick()).toEqual({ schedules: 1, briefings: 0 });
    expect(result).toMatchObject({ ok: true, data: { to: "010-****-5678" } });
    expect(calls.at(-1)!.get("To")).toBe(E164);
    expect(calls.at(-1)!.get("Twiml")).toContain("좋은 아침이에요! 일어날 시간이에요.");
  });
});
