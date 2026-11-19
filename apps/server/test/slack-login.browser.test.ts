/**
 * Slack login relay end to end: real headless Chrome (Playwright, channel "chrome") against the local fake Slack
 * sign-in site (fixtures/fake-slack.ts) through the real routes, enclave, vault and MessengerHub.
 * Covers: email code (workspace and global, multi-workspace pick), wrong/expired code, password + 2FA, new-device
 * code, password-only workspace, SSO, unknown workspace, captcha, timeout, cancel mid-step, and that every path
 * closes Chrome and removes its temporary profile. Finally greps all captured logs for every fake secret.
 *
 * OPT-IN: a plain `bun test` skips this file — it drives real Chrome processes, so its speed depends on how loaded the
 * machine is, and the shared gate must not flip with load. Run it on purpose (serially, its own Chrome per relay):
 *   PICKLE_BROWSER_TESTS=1 bun test apps/server/test/slack-login.browser.test.ts
 * Waits are on explicit readiness (what the fake site received, the relay's own expiresAt, the process table), never
 * on a guessed sleep; step timeouts are the generous ones a loaded machine needs. Skipped when Chrome is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PlaywrightSlackDriver, type DriverOptions } from "../src/slack-login/driver.ts";
import type { SlackLoginOptions } from "../src/slack-login/relay.ts";
import { ACCOUNTS, CODE, D_COOKIE_PREFIX, EXPIRED_CODE, startFakeSlack, tokenFor, type FakeSlack } from "./fixtures/fake-slack.ts";
import { makeRelayHarness, type RelayHarness } from "./fixtures/relay-harness.ts";

const CHROME = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].some((p) => existsSync(p));
const run = CHROME && process.env.PICKLE_BROWSER_TESTS === "1";
/** per test: several relays, each launching its own Chrome, on a machine that may be busy */
const T = 180_000;

interface Rec {
  d: PlaywrightSlackDriver;
  pid: number | null;
  profile: string | null;
  closed: Promise<void> | null;
}

let site: FakeSlack;
let h: RelayHarness;
const drivers: Rec[] = [];
const allLogs: string[] = [];
let n = 0;

async function harness(extra: Partial<SlackLoginOptions> = {}): Promise<RelayHarness> {
  const hh = await makeRelayHarness({
    urls: site.urls,
    // nothing here relies on a timeout firing (every failure case is recognised on the page), so they only need to be long
    stepTimeoutMs: 30_000,
    tokenTimeoutMs: 30_000,
    startsPerWindow: 100,
    driver: (o: DriverOptions) => {
      const d = new PlaywrightSlackDriver(o);
      const rec: Rec = { d, pid: null, profile: null, closed: null };
      const close = d.close.bind(d);
      d.close = () => (rec.closed ??= (async () => {
        rec.pid = d.pid;
        if (rec.pid) rec.profile = profileOf(rec.pid);
        await close();
      })());
      drivers.push(rec);
      return d;
    },
    ...extra,
  }, { slackApiUrl: `${site.base}/api` });
  return hh;
}

/** Playwright's temporary --user-data-dir of a running Chrome */
function profileOf(pid: number): string | null {
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)]).toString();
    return /--user-data-dir=(\S+)/.exec(cmd)?.[1] ?? null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** poll `ok` (explicit readiness) up to `ms`; true when it held */
async function eventually(ok: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await Bun.sleep(100);
  }
  return ok();
}

/**
 * every driver of this test: closed, Chrome gone, profile directory removed. The process exit and Playwright's profile
 * removal finish asynchronously after close() (slower on a loaded machine), so both are awaited, bounded at 20 s.
 */
async function expectCleanedUp(from: number) {
  const mine = drivers.slice(from);
  expect(mine.length).toBeGreaterThan(0);
  for (const r of mine) {
    expect(r.closed).not.toBeNull();
    await r.closed;
    expect(r.d.isClosed).toBe(true);
    expect(r.pid).toBeGreaterThan(0);
    expect(r.profile).toMatch(/playwright_chromiumdev_profile-/);
    expect(await eventually(() => !alive(r.pid!))).toBe(true);
    expect(await eventually(() => !existsSync(r.profile!))).toBe(true);
  }
}

async function user() {
  const a = await h.signup(`b${++n}x${Math.floor(Math.random() * 1e5)}`);
  return { token: a.token, userId: a.session.user.id };
}

describe.skipIf(!run)("slack login relay in Chrome against a fake Slack", () => {
  beforeAll(async () => {
    site = startFakeSlack();
    h = await harness();
  });
  afterAll(async () => {
    allLogs.push(...h.logs);
    await h.close();
    site.stop();
  });

  test("workspace + email code: wrong code, then the right one → connected; Chrome and its profile are gone", async () => {
    const from = drivers.length;
    const { token, userId } = await user();
    const s = await h.start(token, userId, { workspace: "acme.slack.com", email: "kim@example.com" });
    expect(s.body).toMatchObject({ state: "needs_code", codeLength: 6 });
    const wrong = await h.step(token, userId, s.body.relayId, "code", "AAAAAA");
    expect(wrong.body).toMatchObject({ state: "needs_code", error: { code: "wrong_code" } });
    const ok = await h.step(token, userId, s.body.relayId, "code", CODE.toLowerCase());
    expect(ok.body.state).toBe("connected");
    expect(ok.body.connection).toMatchObject({ provider: "slack", status: "connected" });
    expect(h.slack.logins.at(-1)?.token).toBe(tokenFor("T0ACME001"));
    expect(h.slack.logins.at(-1)?.cookie.startsWith(D_COOKIE_PREFIX)).toBe(true);
    expect((await h.vault.list(userId))[0]).toMatchObject({ service: "slack", kind: "token", hint: "acme.slack.com" });
    expect(site.seen.emails.at(-1)).toBe("kim@example.com");
    expect(site.seen.codes.slice(-2)).toEqual(["AAAAAA", CODE]);
    await expectCleanedUp(from);
    // 연결 해제: the relay's session is signed out at Slack with exactly what was extracted, then leaves the vault
    const used = h.slack.logins.at(-1)!;
    const before = site.seen.signouts.length;
    expect((await h.req("DELETE", "/api/connections/slack", { token })).status).toBe(200);
    expect(site.seen.signouts.slice(before)).toEqual([{ token: used.token, cookie: used.cookie }]);
    expect(await h.vault.list(userId)).toEqual([]);
  }, T);

  test("global sign-in (no workspace) with two workspaces → pick one → connected to that one", async () => {
    const from = drivers.length;
    const { token, userId } = await user();
    const s = await h.start(token, userId, { email: "multi@example.com" });
    expect(s.body.state).toBe("needs_code");
    const w = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(w.body.state).toBe("workspaces");
    expect(w.body.workspaces).toEqual([
      { id: "w1", name: "Acme Corp", domain: "acme.slack.com" },
      { id: "w2", name: "Beta Labs", domain: "beta.slack.com" },
    ]);
    const ok = await h.step(token, userId, s.body.relayId, "teamId", "w2");
    expect(ok.body.state).toBe("connected");
    expect(ok.body.connection?.accountLabel).toContain("Beta Labs");
    expect(h.slack.logins.at(-1)?.token).toBe(tokenFor("T0BETA002"));
    await expectCleanedUp(from);
  }, T);

  test("global sign-in with one workspace picks it without asking", async () => {
    const from = drivers.length;
    const { token, userId } = await user();
    const s = await h.start(token, userId, { email: "kim@example.com" });
    const ok = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(ok.body.state).toBe("connected");
    await expectCleanedUp(from);
  }, T);

  test("password → wrong password → 2FA → wrong TOTP → right TOTP → connected", async () => {
    const from = drivers.length;
    const { token, userId } = await user();
    const s = await h.start(token, userId, { workspace: "acme", method: "password", email: "twofa@example.com" });
    expect(s.body.state).toBe("needs_password");
    const bad = await h.step(token, userId, s.body.relayId, "password", "wrong-password");
    expect(bad.body).toMatchObject({ state: "needs_password", error: { code: "wrong_password" } });
    const two = await h.step(token, userId, s.body.relayId, "password", ACCOUNTS["twofa@example.com"]!.password);
    expect(two.body).toMatchObject({ state: "needs_2fa" });
    const badT = await h.step(token, userId, s.body.relayId, "totp", "111111");
    expect(badT.body).toMatchObject({ state: "needs_2fa", error: { code: "wrong_totp" } });
    const ok = await h.step(token, userId, s.body.relayId, "totp", "246810");
    expect(ok.body.state).toBe("connected");
    expect(site.seen.passwords.slice(-2)).toEqual(["wrong-password", "pw-2fa"]);
    await expectCleanedUp(from);
  }, T);

  test("password on a new device → emailed code → connected", async () => {
    const from = drivers.length;
    const { token, userId } = await user();
    const s = await h.start(token, userId, { workspace: "acme", method: "password", email: "newdevice@example.com" });
    const c = await h.step(token, userId, s.body.relayId, "password", "pw-new");
    expect(c.body).toMatchObject({ state: "needs_code", codeLength: 6 });
    const ok = await h.step(token, userId, s.body.relayId, "code", CODE);
    expect(ok.body.state).toBe("connected");
    await expectCleanedUp(from);
  }, T);

  test("a workspace without email codes falls back to its password form", async () => {
    const from = drivers.length;
    const { token, userId } = await user();
    // pwonly is not one of kim's workspaces: the password is refused like Slack would
    const s = await h.start(token, userId, { workspace: "pwonly", email: "kim@example.com" });
    expect(s.body.state).toBe("needs_password");
    const bad = await h.step(token, userId, s.body.relayId, "password", "pw-correct-horse");
    expect(bad.body.error?.code).toBe("wrong_password");
    await h.req("POST", "/api/connections/slack/login/cancel", { token, body: { relayId: s.body.relayId } });
    await expectCleanedUp(from);
  }, T);

  test("SSO-only workspace → sso_unsupported (both methods), browser closed", async () => {
    const from = drivers.length;
    const { token, userId } = await user();
    const s = await h.start(token, userId, { workspace: "ssoco", email: "member@ssoco.example" });
    expect(s.body).toMatchObject({ state: "error", error: { code: "sso_unsupported" } });
    const p = await h.start(token, userId, { workspace: "ssoco", method: "password", email: "member@ssoco.example" });
    expect(p.body.state).toBe("needs_password"); // the guest password form (no_sso=1)
    const r = await h.step(token, userId, p.body.relayId, "password", "pw-sso");
    expect(r.body).toMatchObject({ state: "error", error: { code: "sso_unsupported" } });
    await expectCleanedUp(from);
  }, T);

  test("unknown workspace, expired code and captcha end the relay with their own codes", async () => {
    const from = drivers.length;
    const { token, userId } = await user();
    const nf = await h.start(token, userId, { workspace: "no-such-team", email: "kim@example.com" });
    expect(nf.body).toMatchObject({ state: "error", error: { code: "workspace_not_found" } });
    const s = await h.start(token, userId, { workspace: "acme", email: "kim@example.com" });
    const ex = await h.step(token, userId, s.body.relayId, "code", EXPIRED_CODE);
    expect(ex.body).toMatchObject({ state: "error", error: { code: "code_expired" } });
    const cap = await h.start(token, userId, { workspace: "acme", email: "captcha@example.com" });
    expect(cap.body).toMatchObject({ state: "error", error: { code: "captcha" } });
    await expectCleanedUp(from);
  }, T);

  test("cancel while the email step is still running closes Chrome", async () => {
    const from = drivers.length;
    const { token, userId } = await user();
    const pending = h.start(token, userId, { workspace: "acme", email: "slow@example.com" }); // the fake holds this answer 15 s
    // readiness: the relay's Chrome has submitted the email and is waiting on the fake's answer
    expect(await eventually(() => site.seen.emails.includes("slow@example.com"), 60_000)).toBe(true);
    // the relayId is not known to the client yet: starting again replaces the running relay
    const again = h.start(token, userId, { workspace: "acme", email: "kim@example.com" });
    const first = await pending;
    expect(first.body).toMatchObject({ state: "error", error: { code: "cancelled" } });
    const second = await again;
    expect(second.body.state).toBe("needs_code");
    const c = await h.req("POST", "/api/connections/slack/login/cancel", { token, body: { relayId: second.body.relayId } });
    expect(c.status).toBe(200);
    await expectCleanedUp(from);
  }, T);

  test("timeout: the relay closes on its own after ttl", async () => {
    // long enough for the start (Chrome launch + email step) to finish on a busy machine; then wait for expiresAt itself
    const hh = await harness({ ttlMs: 25_000 });
    const from = drivers.length;
    try {
      const a = await hh.signup("timeoutuser");
      const s = await hh.start(a.token, a.session.user.id, { workspace: "acme", email: "kim@example.com" });
      expect(s.body.state).toBe("needs_code");
      await Bun.sleep(Math.max(0, s.body.expiresAt - Date.now()) + 500);
      const late = await hh.step(a.token, a.session.user.id, s.body.relayId, "code", CODE);
      expect(late.body).toMatchObject({ state: "error", error: { code: "timeout" } });
      await expectCleanedUp(from);
    } finally {
      allLogs.push(...hh.logs);
      await hh.close();
    }
  }, T);

  test("no fake secret ever reached the logs", async () => {
    const text = [...h.logs, ...allLogs].join("\n");
    expect(text).toContain("slack_login"); // the relay did log its steps
    expect(text).toMatch(/ws=a\*\*e/);
    const secrets = [
      ...Object.keys(ACCOUNTS),
      ...Object.values(ACCOUNTS).map((a) => a.password),
      "246810",
      "111111",
      "wrong-password",
      CODE,
      CODE.toLowerCase(),
      EXPIRED_CODE,
      "AAAAAA",
      tokenFor("T0ACME001"),
      tokenFor("T0BETA002"),
      D_COOKIE_PREFIX,
      "FAKEsecretcookie",
      "xoxc-",
      "xoxd-",
      "acme.slack.com",
      "ws=acme",
    ];
    for (const s of secrets) expect(text).not.toContain(s);
  });
});
