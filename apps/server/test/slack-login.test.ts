/**
 * Slack login relay, server side, with a scripted driver (no browser): routes, sealing, validation, rate limits,
 * one relay per user, the server-wide browser cap, timeout, cancel, the multi-team pick, cleanup and log hygiene.
 * The browser itself is covered by slack-login.browser.test.ts against the local fake Slack site.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { DriverOptions, DriverOutcome, SlackDriver, SlackExtract } from "../src/slack-login/driver.ts";
import { maskWorkspace, normalizeWorkspace } from "../src/slack-login/relay.ts";
import { startFakeSlack } from "./fixtures/fake-slack.ts";
import { makeRelayHarness, type RelayHarness } from "./fixtures/relay-harness.ts";

const TOKEN_A = "xoxc-FAKE-T0ACME001-9999999999-8888888888-feedfacecafe";
const TOKEN_B = "xoxc-FAKE-T0BETA002-9999999999-8888888888-feedfacecafe";
const COOKIE = "xoxd-FAKEunitcookie%2Fzzz%3D";
const EMAIL = "secret.person@example.com";
const CODE = "K3P9Z1";
const PASSWORD = "hunter2-very-secret";

/** A driver that plays back a script; records what it was asked to type and whether it was closed. */
class ScriptedDriver implements SlackDriver {
  typed: string[] = [];
  closed = false;
  constructor(
    private readonly plan: {
      start?: (i: { domain: string | null; method: string }) => Promise<DriverOutcome> | DriverOutcome;
      code?: (c: string) => DriverOutcome;
      password?: (p: string) => DriverOutcome;
      totp?: (c: string) => DriverOutcome;
      pick?: (id: string) => DriverOutcome;
      extract?: () => SlackExtract;
    },
  ) {}
  async start(i: { domain: string | null; email: string; method: "code" | "password" }) {
    this.typed.push(i.email);
    return this.plan.start ? this.plan.start(i) : { kind: "needs_code" as const, codeLength: 6 };
  }
  async submitCode(c: string) {
    this.typed.push(c);
    return this.plan.code ? this.plan.code(c) : c === CODE ? { kind: "signed_in" as const } : { kind: "error" as const, code: "wrong_code" as const };
  }
  async submitPassword(p: string) {
    this.typed.push(p);
    return this.plan.password ? this.plan.password(p) : { kind: "signed_in" as const };
  }
  async submitTotp(c: string) {
    this.typed.push(c);
    return this.plan.totp ? this.plan.totp(c) : { kind: "signed_in" as const };
  }
  async pickWorkspace(id: string) {
    return this.plan.pick ? this.plan.pick(id) : { kind: "signed_in" as const };
  }
  async extract(): Promise<SlackExtract> {
    return this.plan.extract ? this.plan.extract() : { teams: [{ teamId: "T0ACME001", name: "Acme Corp", domain: "acme", token: TOKEN_A }], cookie: COOKIE };
  }
  async close() {
    this.closed = true;
  }
}

let h: RelayHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function setup(plan: ConstructorParameters<typeof ScriptedDriver>[0] = {}, opts: Record<string, number> = {}) {
  const drivers: ScriptedDriver[] = [];
  h = await makeRelayHarness({
    driver: (_o: DriverOptions) => {
      const d = new ScriptedDriver(plan);
      drivers.push(d);
      return d;
    },
    ...opts,
  });
  const auth = await h.signup(`user${Math.floor(Math.random() * 1e6)}`);
  return { h, drivers, token: auth.token, userId: auth.session.user.id };
}

function assertNoSecretsInLogs(logs: string[], extra: string[] = []) {
  const text = logs.join("\n");
  for (const s of [EMAIL, "secret.person", CODE, PASSWORD, TOKEN_A, TOKEN_B, COOKIE, "xoxc-", "xoxd-", ...extra]) expect(text).not.toContain(s);
}

describe("slack login relay: helpers", () => {
  test("normalizeWorkspace accepts names, domains and URLs", () => {
    expect(normalizeWorkspace("Sionic")).toBe("sionic");
    expect(normalizeWorkspace("sionic.slack.com")).toBe("sionic");
    expect(normalizeWorkspace("https://sionic.slack.com/messages/C1")).toBe("sionic");
    expect(normalizeWorkspace("uber.enterprise.slack.com")).toBe("uber.enterprise");
    expect(normalizeWorkspace("")).toBeNull();
    expect(normalizeWorkspace(undefined)).toBeNull();
    expect(() => normalizeWorkspace("evil.com/../x y")).toThrow();
    expect(() => normalizeWorkspace("-bad-")).toThrow();
  });

  test("maskWorkspace keeps the first and last letter only", () => {
    expect(maskWorkspace("sionic")).toBe("s****c");
    expect(maskWorkspace("acme")).toBe("a**e");
    expect(maskWorkspace(null)).toBe("-");
  });
});

describe("slack login relay: API", () => {
  test("email code happy path seals the session into the vault and connects through auth.test", async () => {
    const { h, drivers, token, userId } = await setup();
    const s = await h.start(token, userId, { workspace: "acme.slack.com", email: EMAIL });
    expect(s.status).toBe(200);
    expect(s.body.state).toBe("needs_code");
    expect(s.body.codeLength).toBe(6);
    expect(s.body.relayId).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const wrong = await h.step(token, userId, s.body.relayId, "code", "AAAAAA");
    expect(wrong.body.state).toBe("needs_code");
    expect(wrong.body.error?.code).toBe("wrong_code");
    expect(wrong.body.error?.message).toContain("코드");

    const ok = await h.step(token, userId, s.body.relayId, "code", "k3p-9z1"); // dashes/lowercase are normalised
    expect(ok.body.state).toBe("connected");
    expect(ok.body.connection?.status).toBe("connected");
    expect(ok.body.connection?.accountLabel).toContain("Acme Corp");
    expect(drivers[0]!.typed).toEqual([EMAIL, "AAAAAA", CODE]);
    expect(drivers[0]!.closed).toBe(true);

    // the vault holds a token credential; auth.test saw exactly the extracted token + cookie
    const creds = await h.vault.list(userId);
    expect(creds).toHaveLength(1);
    expect(creds[0]).toMatchObject({ service: "slack", kind: "token", hint: "acme.slack.com", keepFor: "30d" });
    expect(h.slack.logins.at(-1)).toEqual({ token: TOKEN_A, cookie: COOKIE });
    const conns = await (await h.req("GET", "/api/connections", { token })).json();
    expect(conns.connections.find((c: { provider: string }) => c.provider === "slack")?.status).toBe("connected");
    // nothing typed or extracted reaches a response body or the logs
    expect(JSON.stringify([s.body, wrong.body, ok.body])).not.toContain(TOKEN_A);
    assertNoSecretsInLogs(h.logs, ["acme.slack"]);
    expect(h.logs.join("\n")).toContain("ws=a**e");
  });

  test("the connection owns the relay session: re-login signs the old one out and replaces the row; disconnect signs out and deletes", async () => {
    const fake = startFakeSlack(); // only its Web API (/api/auth.signout) is used here
    try {
      h = await makeRelayHarness({ driver: () => new ScriptedDriver({}) }, { slackApiUrl: `${fake.base}/api` });
      const auth = await h.signup(`user${Math.floor(Math.random() * 1e6)}`);
      const [token, userId] = [auth.token, auth.session.user.id];
      const login = async () => {
        const s = await h!.start(token, userId, { workspace: "acme", email: EMAIL });
        return (await h!.step(token, userId, s.body.relayId, "code", CODE)).body;
      };
      expect((await login()).state).toBe("connected");
      const first = (await h.vault.list(userId)).map((c) => c.id);
      expect((await login()).state).toBe("connected");
      const second = (await h.vault.list(userId)).map((c) => c.id);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1); // rows never pile up
      expect(second[0]).not.toBe(first[0]);
      // the replaced session was signed out at Slack (hub: revoke before dropping the old row)
      expect(fake.seen.signouts).toEqual([{ token: TOKEN_A, cookie: COOKIE }]);

      const del = await h.req("DELETE", "/api/connections/slack", { token });
      expect(del.status).toBe(200);
      expect(fake.seen.signouts).toEqual([{ token: TOKEN_A, cookie: COOKIE }, { token: TOKEN_A, cookie: COOKIE }]);
      expect(await h.vault.list(userId)).toEqual([]);
      const log = await h.vault.accessLog(userId);
      expect(log.some((r) => r.action === "logout" && r.outcome === "ok")).toBe(true);
      assertNoSecretsInLogs(h.logs);
    } finally {
      fake.stop();
    }
  });

  test("password → 2FA path, with wrong answers kept retryable", async () => {
    const { h, drivers, token, userId } = await setup({
      start: () => ({ kind: "needs_password" }),
      password: (p) => (p === PASSWORD ? { kind: "needs_2fa", codeLength: 6 } : { kind: "error", code: "wrong_password" }),
      totp: (c) => (c === "246810" ? { kind: "signed_in" } : { kind: "error", code: "wrong_totp" }),
    });
    const s = await h.start(token, userId, { workspace: "acme", method: "password", email: EMAIL });
    expect(s.body.state).toBe("needs_password");
    const bad = await h.step(token, userId, s.body.relayId, "password", "nope");
    expect(bad.body).toMatchObject({ state: "needs_password", error: { code: "wrong_password" } });
    const two = await h.step(token, userId, s.body.relayId, "password", PASSWORD);
    expect(two.body).toMatchObject({ state: "needs_2fa", codeLength: 6 });
    // a code where a TOTP is expected is refused without touching the relay
    const wrongKind = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(wrongKind.status).toBe(409);
    const badTotp = await h.step(token, userId, s.body.relayId, "totp", "000000");
    expect(badTotp.body).toMatchObject({ state: "needs_2fa", error: { code: "wrong_totp" } });
    const ok = await h.step(token, userId, s.body.relayId, "totp", "246810");
    expect(ok.body.state).toBe("connected");
    expect(drivers[0]!.typed).toEqual([EMAIL, "nope", PASSWORD, "000000", "246810"]);
    assertNoSecretsInLogs(h.logs, ["246810", "hunter2"]);
  });

  test("several teams after sign-in: tokens are held in memory until the person picks one", async () => {
    const { h, drivers, token, userId } = await setup({
      extract: () => ({
        teams: [
          { teamId: "T0ACME001", name: "Acme Corp", domain: "acme", token: TOKEN_A },
          { teamId: "T0BETA002", name: "Beta Labs", domain: "beta", token: TOKEN_B },
        ],
        cookie: COOKIE,
      }),
    });
    const s = await h.start(token, userId, { email: EMAIL });
    const w = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(w.body.state).toBe("workspaces");
    expect(w.body.workspaces).toEqual([
      { id: "T0ACME001", name: "Acme Corp", domain: "acme.slack.com" },
      { id: "T0BETA002", name: "Beta Labs", domain: "beta.slack.com" },
    ]);
    expect(drivers[0]!.closed).toBe(true); // browser closed as soon as the tokens were read
    expect(JSON.stringify(w.body)).not.toContain("xoxc-");
    const bad = await h.step(token, userId, s.body.relayId, "teamId", "T0NOPE");
    expect(bad.status).toBe(400);
    const ok = await h.step(token, userId, s.body.relayId, "teamId", "T0BETA002");
    expect(ok.body.state).toBe("connected");
    expect(h.slack.logins.at(-1)?.token).toBe(TOKEN_B);
    assertNoSecretsInLogs(h.logs);
  });

  test("a workspace list from Slack's own page is passed through and picked in the browser", async () => {
    let picked = "";
    const { h, token, userId } = await setup({
      code: () => ({ kind: "workspaces", workspaces: [{ id: "w1", name: "Acme Corp", domain: "acme.slack.com" }, { id: "w2", name: "Beta Labs", domain: "beta.slack.com" }] }),
      pick: (id) => {
        picked = id;
        return { kind: "signed_in" };
      },
    });
    const s = await h.start(token, userId, { email: EMAIL });
    const w = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(w.body.workspaces?.map((x) => x.id)).toEqual(["w1", "w2"]);
    const ok = await h.step(token, userId, s.body.relayId, "teamId", "w2");
    expect(ok.body.state).toBe("connected");
    expect(picked).toBe("w2");
  });

  test("terminal errors close the relay; a late step gets the reason, not a 404", async () => {
    const { h, drivers, token, userId } = await setup({ start: () => ({ kind: "error", code: "sso_unsupported" }) });
    const s = await h.start(token, userId, { workspace: "ssoco", email: EMAIL });
    expect(s.body).toMatchObject({ state: "error", error: { code: "sso_unsupported" } });
    expect(s.body.error?.message).toContain("SSO");
    expect(drivers[0]!.closed).toBe(true);
    const late = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ state: "error", error: { code: "sso_unsupported" } });
  });

  test("too many wrong codes stop the relay", async () => {
    const { h, drivers, token, userId } = await setup({}, { maxAttempts: 3 });
    const s = await h.start(token, userId, { workspace: "acme", email: EMAIL });
    await h.step(token, userId, s.body.relayId, "code", "AAAAA1");
    await h.step(token, userId, s.body.relayId, "code", "AAAAA2");
    const third = await h.step(token, userId, s.body.relayId, "code", "AAAAA3");
    expect(third.body).toMatchObject({ state: "error", error: { code: "too_many_attempts" } });
    expect(drivers[0]!.closed).toBe(true);
  });

  test("auth.test failure removes the sealed session again", async () => {
    const { h, token, userId } = await setup();
    h.slack.accept = /^never/;
    const s = await h.start(token, userId, { workspace: "acme", email: EMAIL });
    const r = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(r.body).toMatchObject({ state: "error", error: { code: "auth_failed" } });
    expect(await h.vault.list(userId)).toHaveLength(0);
  });

  test("timeout closes the browser and answers the next step with 'timeout'", async () => {
    const { h, drivers, token, userId } = await setup({}, { ttlMs: 150 });
    const s = await h.start(token, userId, { workspace: "acme", email: EMAIL });
    expect(s.body.expiresAt).toBeGreaterThan(Date.now() - 1000);
    await Bun.sleep(300);
    expect(drivers[0]!.closed).toBe(true);
    const r = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(r.body).toMatchObject({ state: "error", error: { code: "timeout" } });
  });

  test("cancel closes the browser, also while a step is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { h, drivers, token, userId } = await setup({
      start: async () => {
        await gate;
        return { kind: "needs_code", codeLength: 6 };
      },
    });
    const pending = h.start(token, userId, { workspace: "acme", email: EMAIL });
    await Bun.sleep(50);
    // the relayId is not known yet: a second start replaces (cancels) the first
    const s2p = h.start(token, userId, { workspace: "acme", email: EMAIL });
    await Bun.sleep(50);
    expect(drivers[0]!.closed).toBe(true);
    release();
    const first = await pending;
    expect(first.body).toMatchObject({ state: "error", error: { code: "cancelled" } });
    const s2 = await s2p;
    expect(s2.body.state).toBe("needs_code");
    const c = await h.req("POST", "/api/connections/slack/login/cancel", { token, body: { relayId: s2.body.relayId } });
    expect(c.status).toBe(200);
    expect(drivers[1]!.closed).toBe(true);
    const late = await h.step(token, userId, s2.body.relayId, "code", CODE);
    expect(late.body).toMatchObject({ state: "error", error: { code: "cancelled" } });
  });

  test("per-user start rate limit answers 429 with Retry-After", async () => {
    const { h, token, userId } = await setup({}, { startsPerWindow: 2 });
    expect((await h.start(token, userId, { workspace: "acme", email: EMAIL })).status).toBe(200);
    expect((await h.start(token, userId, { workspace: "acme", email: EMAIL })).status).toBe(200);
    const third = await h.req("POST", "/api/connections/slack/login", { token, body: { email: await h.seal(userId, "start", { email: EMAIL }) } });
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("server-wide browser cap answers 503 relay_busy", async () => {
    const { h, token, userId } = await setup({}, { maxConcurrent: 1 });
    const other = await h.signup("otheruser1");
    expect((await h.start(token, userId, { workspace: "acme", email: EMAIL })).body.state).toBe("needs_code");
    const r = await h.start(other.token, other.session.user.id, { workspace: "acme", email: EMAIL });
    expect(r.status).toBe(503);
    expect((r.body as { error?: unknown }).error).toBe("relay_busy");
  });

  test("validation: auth, JSON only, sealed inputs bound to this user and this relay", async () => {
    const { h, token, userId } = await setup();
    const other = await h.signup("otheruser2");
    const sealed = await h.seal(userId, "start", { email: EMAIL });
    expect((await h.req("POST", "/api/connections/slack/login", { body: { email: sealed } })).status).toBe(401);
    const form = await h.req("POST", "/api/connections/slack/login", { token, raw: "email=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(415);
    const textPlain = await h.req("POST", "/api/connections/slack/login", { token, body: { email: sealed }, headers: { "content-type": "text/plain" } });
    expect(textPlain.status).toBe(415);
    // plaintext instead of an envelope
    const plain = await h.req("POST", "/api/connections/slack/login", { token, body: { email: EMAIL } });
    expect(plain.status).toBe(400);
    expect((await plain.json()).error).toBe("invalid_envelope");
    // sealed for another user (aad mismatch) → refused
    const foreign = await h.req("POST", "/api/connections/slack/login", { token: other.token, body: { email: sealed } });
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).not.toContain(EMAIL);
    // other providers have no relay
    expect((await h.req("POST", "/api/connections/kakaotalk/login", { token, body: { email: sealed } })).status).toBe(404);
    expect((await h.req("POST", "/api/connections/slack/login", { token, body: { email: sealed, provider: "discord" } })).status).toBe(400);
    expect((await h.req("POST", "/api/connections/slack/login", { token, body: { email: sealed, workspace: "a/b c" } })).status).toBe(400);
    expect((await h.req("POST", "/api/connections/slack/login", { token, body: { email: sealed, method: "magic" } })).status).toBe(400);

    const s = await h.start(token, userId, { workspace: "acme", email: EMAIL });
    // a code sealed for the start aad (not this relay) is refused, and the relay survives it
    const replay = await h.req("POST", "/api/connections/slack/login/step", { token, body: { relayId: s.body.relayId, code: await h.seal(userId, "start", { code: CODE }) } });
    expect(replay.status).toBe(400);
    const two = await h.req("POST", "/api/connections/slack/login/step", { token, body: { relayId: s.body.relayId, code: await h.seal(userId, s.body.relayId, { code: CODE }), teamId: "x" } });
    expect(two.status).toBe(400);
    const shortCode = await h.step(token, userId, s.body.relayId, "code", "123");
    expect(shortCode.status).toBe(400);
    // another user cannot drive or cancel my relay
    const steal = await h.req("POST", "/api/connections/slack/login/step", { token: other.token, body: { relayId: s.body.relayId, teamId: "w1" } });
    expect(steal.status).toBe(404);
    await h.req("POST", "/api/connections/slack/login/cancel", { token: other.token, body: { relayId: s.body.relayId } });
    const ok = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(ok.body.state).toBe("connected");
    assertNoSecretsInLogs(h.logs);
  });

  test("a sealed email that is not an email is refused before any browser opens", async () => {
    const { h, drivers, token, userId } = await setup();
    const r = await h.start(token, userId, { workspace: "acme", email: "not-an-email" });
    expect(r.status).toBe(400);
    expect(drivers).toHaveLength(0);
  });
});
