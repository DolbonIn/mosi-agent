/**
 * Slack sign-out on disconnect (adapters/slack.ts `revoke` → `slackSignOut`): the REAL adapter code against a local fake
 * of Slack's Web API (never slack.com). A session the login relay produced (`connect … { session: true }`) is signed out
 * exactly once; a pasted token (the user's own credential) never is; failures and hangs never block disconnect.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { join } from "node:path";
import { MessengerHub } from "../src/index.ts";
import { slackSignOut } from "../src/adapters/slack.ts";
import { fakeSlack, harness, sealedLogin, type Harness } from "./helpers.ts";

const U = "user_1";
const SESSION = { token: "xoxc-relay-111-222-abc", cookie: "xoxd-RELAY%2FCOOKIE%3D" };

type Mode = "ok" | "unknown_method" | "ratelimited" | "invalid_auth" | "http500" | "hang";
interface Call {
  method: string;
  authorization: string | null;
  cookie: string | null;
  contentType: string | null;
}

/** a fake https://slack.com/api: records each call; `mode` decides the answer */
function fakeSlackApi() {
  const calls: Call[] = [];
  const state = { mode: "ok" as Mode };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = url.pathname.replace(/^\/api\//, "");
      // the login's auth.test (the adapter validates the session): answered, not recorded — `calls` are sign-outs
      if (method === "auth.test") return Response.json({ ok: true, user_id: "U1", team_id: "T1", user: "haneul", team: "Acme" });
      calls.push({ method, authorization: req.headers.get("authorization"), cookie: req.headers.get("cookie"), contentType: req.headers.get("content-type") });
      await req.text();
      const m = state.mode;
      if (m === "hang") return new Promise<Response>(() => {});
      if (m === "http500") return new Response("upstream exploded", { status: 500 });
      if (m === "unknown_method" && method === "auth.signout") return Response.json({ ok: false, error: "unknown_method" });
      if (m === "ratelimited") return Response.json({ ok: false, error: "ratelimited" });
      if (m === "invalid_auth") return Response.json({ ok: false, error: "invalid_auth" });
      return Response.json({ ok: true });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/api`, calls, state, stop: () => server.stop(true) };
}

let h: Harness | null = null;
let api: ReturnType<typeof fakeSlackApi> | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
  api?.stop();
  api = null;
});

const signal = () => new AbortController().signal;

describe("slackSignOut (the request Slack gets)", () => {
  test("auth.signout once, with the session as Bearer token + d cookie", async () => {
    api = fakeSlackApi();
    await slackSignOut(SESSION, signal(), api.url);
    expect(api.calls).toEqual([{ method: "auth.signout", authorization: `Bearer ${SESSION.token}`, cookie: `d=${SESSION.cookie}`, contentType: "application/x-www-form-urlencoded; charset=utf-8" }]);
  });

  test("a workspace without auth.signout falls back to auth.revoke", async () => {
    api = fakeSlackApi();
    api.state.mode = "unknown_method";
    await slackSignOut(SESSION, signal(), api.url);
    expect(api.calls.map((c) => c.method)).toEqual(["auth.signout", "auth.revoke"]);
  });

  test("already signed out (invalid_auth) counts as done; other answers throw without the secret in the message", async () => {
    api = fakeSlackApi();
    api.state.mode = "invalid_auth";
    await slackSignOut(SESSION, signal(), api.url);
    for (const mode of ["ratelimited", "http500"] as const) {
      api.state.mode = mode;
      const err = await slackSignOut(SESSION, signal(), api.url).then(
        () => null,
        (e: unknown) => e as Error & { code?: string },
      );
      expect(err?.code).toBe("upstream");
      expect(err!.message).not.toContain(SESSION.token);
      expect(err!.message).not.toContain("RELAY");
    }
    // no fallback for a real error: auth.signout only
    expect(api.calls.filter((c) => c.method === "auth.revoke")).toEqual([]);
  });
});

describe("disconnect → Slack sign-out (real adapter, fake API)", () => {
  async function setup(revokeMs?: number) {
    api = fakeSlackApi();
    const slack = fakeSlack();
    const sdk = { ...slack.sdk, apiUrl: api.url };
    h = await harness({ slack: async () => sdk });
    if (revokeMs !== undefined) {
      await h.hub.shutdown();
      h.hub = new MessengerHub({ vault: h.vault, storage: h.storage, configRoot: join(h.dir, "m2"), onUpdate: () => {}, sdk: { slack: async () => sdk }, revokeMs, now: () => h!.clock.t });
    }
    return { api, hh: h };
  }
  const relaySession = (hh: Harness) => hh.vault.saveSystem(U, { service: "slack", label: "슬랙 (acme.slack.com)", kind: "token", hint: "acme.slack.com", keepFor: "30d", secret: SESSION });

  test("a relay session is signed out exactly once, then deleted (audited as logout)", async () => {
    const { api, hh } = await setup();
    const saved = await relaySession(hh);
    expect((await hh.hub.connect(U, "slack", { credentialId: saved.id }, { session: true })).connection.status).toBe("connected");
    expect(api.calls).toEqual([]); // connecting never signs anything out
    await hh.hub.disconnect(U, "slack");
    expect(api.calls.map((c) => [c.method, c.authorization, c.cookie])).toEqual([["auth.signout", `Bearer ${SESSION.token}`, `d=${SESSION.cookie}`]]);
    expect(await hh.vault.list(U)).toEqual([]);
    expect((await hh.vault.accessLog(U)).some((r) => r.action === "logout" && r.outcome === "ok" && r.credentialId === saved.id)).toBe(true);
    await hh.hub.disconnect(U, "slack"); // nothing left: no second sign-out
    expect(api.calls.length).toBe(1);
  });

  test("a pasted token (the user's own credential) is never signed out", async () => {
    const { api, hh } = await setup();
    const own = await sealedLogin(hh, U, "slack", { token: "xoxc-own-999", cookie: "xoxd-OWN" }, "token");
    const res = await hh.hub.connect(U, "slack", { credential: own });
    expect(res.connection.status).toBe("connected");
    await hh.hub.disconnect(U, "slack");
    expect(api.calls).toEqual([]);
    expect((await hh.vault.list(U)).map((c) => c.id)).toEqual([res.connection.credentialId!]);
  });

  test("Slack failing, unreachable or hanging never blocks disconnect", async () => {
    const { api, hh } = await setup(150);
    for (const mode of ["http500", "ratelimited", "hang"] as const) {
      api.state.mode = mode;
      const saved = await relaySession(hh);
      await hh.hub.connect(U, "slack", { credentialId: saved.id }, { session: true });
      const t0 = performance.now();
      await hh.hub.disconnect(U, "slack");
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(await hh.vault.list(U)).toEqual([]);
      expect(await hh.hub.connections(U)).toEqual([]);
    }
    expect(api.calls.filter((c) => c.method === "auth.signout").length).toBe(3);
    // unreachable host (connected first: the login's auth.test needs Slack)
    const saved = await relaySession(hh);
    expect((await hh.hub.connect(U, "slack", { credentialId: saved.id }, { session: true })).connection.status).toBe("connected");
    api.stop();
    await hh.hub.disconnect(U, "slack");
    expect(await hh.vault.list(U)).toEqual([]);
    expect((await hh.vault.accessLog(U)).filter((r) => r.action === "logout" && r.outcome === "error").length).toBeGreaterThanOrEqual(2);
  });
});
