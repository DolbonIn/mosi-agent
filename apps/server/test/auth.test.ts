import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message, SessionBootstrap } from "@pickle/protocol";
import { makeDevice, makeHarness, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

describe("auth", () => {
  test("signup returns a token and a full session bootstrap", async () => {
    const { token, session } = await h.signup("haneul", { displayName: "하늘", agentName: "깽이" });
    expect(token.length).toBeGreaterThan(30);
    const s: SessionBootstrap = session;
    expect(s.user).toMatchObject({ handle: "haneul", displayName: "하늘" });
    expect(s.user.id).toStartWith("u_");
    expect(s.agent).toMatchObject({ id: s.user.id, name: "깽이" });
    expect(s.quota).toMatchObject({ usedPct: 0, usedTokens: 0, resetHour: 4 });
    expect(s.quota.limitTokens).toBeGreaterThan(0);
    expect(s.quota.resetsAt).toBe(Date.UTC(2026, 10, 11, 19, 0)); // next 04:00 KST
    expect(s.tickets).toEqual({ basic: 3, premium: 0 });
    expect(s.settings.notifications.briefingTime).toBe("07:30");
    expect(s.settings.privacy.memoryEnabled).toBe(true);
    expect(s.mainThreadId).toStartWith("t_");
    expect(s.unreadThreads).toBe(0);
    expect(s.server).toMatchObject({ llm: "configured", model: "fake-model" });
    expect(h.launcher.profiles.has(s.user.id)).toBe(true);

    // welcome message with a briefing card whose items carry actions
    const msgs = (await (await h.req("GET", `/api/threads/${s.mainThreadId}/messages`, { token })).json()) as Message[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("assistant");
    expect(msgs[0]!.text).toContain("깽이예요");
    expect(msgs[0]!.text).not.toMatch(/암호화|볼 수 없/); // the security note lives on the credential card, not in the greeting
    const card = msgs[0]!.cards[0]!;
    expect(card.type).toBe("briefing");
    if (card.type !== "briefing") throw new Error();
    expect(card.items.map((i) => i.action?.label)).toContain("오늘 날씨 알려 줘");
    expect(card.items.find((i) => i.action?.open === "connections")?.action?.label).toBe("카카오톡 연결하기");
  });

  test("signup validation and duplicate handles", async () => {
    const device = await makeDevice();
    const base = { password: "longenough1", displayName: "a", agentName: "b", device };
    expect((await h.req("POST", "/api/auth/signup", { body: { ...base, handle: "AB" } })).status).toBe(400);
    expect((await h.req("POST", "/api/auth/signup", { body: { ...base, handle: "bad-handle!" } })).status).toBe(400);
    expect((await h.req("POST", "/api/auth/signup", { body: { ...base, handle: "okname", password: "short" } })).status).toBe(400);
    expect((await h.req("POST", "/api/auth/signup", { body: { ...base, handle: "okname", device: { id: "x" } } })).status).toBe(400);
    const priv = { ...device, signingKey: { ...device.signingKey, d: "secret" } };
    expect((await h.req("POST", "/api/auth/signup", { body: { ...base, handle: "okname", device: priv } })).status).toBe(400);
    expect((await h.req("POST", "/api/auth/signup", { body: { ...base, handle: "okname" } })).status).toBe(201);
    const dup = await h.req("POST", "/api/auth/signup", { body: { ...base, handle: "okname" } });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("handle_taken");
  });

  test("login, wrong password, unknown handle use one generic Korean error", async () => {
    const { device } = await h.signup("haneul");
    const ok = await h.req("POST", "/api/auth/login", { body: { handle: "haneul", password: "correct horse battery", device } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { token: string; session: SessionBootstrap };
    expect(body.session.user.handle).toBe("haneul");

    const wrong = await h.req("POST", "/api/auth/login", { body: { handle: "haneul", password: "nope nope nope", device } });
    expect(wrong.status).toBe(401);
    const w = (await wrong.json()) as { error: string; message: string };
    expect(w).toEqual({ error: "invalid_credentials", message: "아이디 또는 비밀번호가 맞지 않아요" });

    const unknown = await h.req("POST", "/api/auth/login", { body: { handle: "ghost", password: "whatever123", device } });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { message: string }).message).toBe("아이디 또는 비밀번호가 맞지 않아요");
  });

  test("session, bearer middleware and logout", async () => {
    const { token } = await h.signup("haneul");
    expect((await h.req("GET", "/api/session")).status).toBe(401);
    expect((await h.req("GET", "/api/session", { token: "x".repeat(43) })).status).toBe(401);
    const s = await h.req("GET", "/api/session", { token });
    expect(s.status).toBe(200);
    expect(((await s.json()) as SessionBootstrap).user.handle).toBe("haneul");
    expect((await h.req("POST", "/api/auth/logout", { token })).status).toBe(200);
    expect((await h.req("GET", "/api/session", { token })).status).toBe(401);
  });

  test("sessions expire after 90 days", async () => {
    const { token } = await h.signup("haneul");
    h.clock.t += 91 * 24 * 3600 * 1000;
    expect((await h.req("GET", "/api/session", { token })).status).toBe(401);
  });

  test("auth routes are rate limited per IP (10/min) with 429", async () => {
    const device = await makeDevice();
    const body = { handle: "nobody", password: "wrongpass1", device };
    for (let i = 0; i < 10; i++) expect((await h.req("POST", "/api/auth/login", { body, ip: "1.2.3.4" })).status).toBe(401);
    const limited = await h.req("POST", "/api/auth/login", { body, ip: "1.2.3.4" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");
    // another IP is unaffected; the window slides
    expect((await h.req("POST", "/api/auth/login", { body, ip: "5.6.7.8" })).status).toBe(401);
    h.clock.t += 61_000;
    expect((await h.req("POST", "/api/auth/login", { body, ip: "1.2.3.4" })).status).toBe(401);
  });
});
