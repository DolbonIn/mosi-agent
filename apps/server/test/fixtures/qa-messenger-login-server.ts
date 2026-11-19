/**
 * QA server for the 디스코드 / 텔레그램 로그인 screens (apps/mobile/qa/messenger-login.spec.mjs). NEVER a real account:
 *   - a throwaway data dir (temp, deleted on exit), its own port (QA_MLOGIN_PORT, default 8831)
 *   - the REAL vault + enclave + MessengerHub + login relay; Discord runs agent-messenger's real loginWithRemoteAuth
 *     against an in-memory fake remote-auth gateway, Telegram runs our real TDLib runtime / driver / adapter over the
 *     fake libtdjson (packages/messengers/test/fake-tdlib.ts)
 * QA-only controls (this process only, never in the app): the spec plays "the person's Discord app" and the operator:
 *   POST /qa/discord/scan | approve | reject | expire   — the latest gateway scans / approves / cancels / times out
 *   POST /qa/discord/exchange {mode:"token"|"captcha"}
 *   POST /qa/telegram {ready?:boolean, twoFa?:boolean}  — api_id configured or not (→ "준비 중이에요"), 2FA on/off
 * Run from the repo root: bun run apps/server/test/fixtures/qa-messenger-login-server.ts
 * Prints `QA_READY <api>` when listening. Logs go to stdout so the spec can grep them for secrets.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Enclave, Vault } from "@pickle/vault";
import { MessengerHub, providers } from "@pickle/messengers";
import { TdRuntime } from "@pickle/messengers/login";
import { createApp, type App } from "../../src/app.ts";
import { openDatabase } from "../../src/db/index.ts";
import { FakeTdJson } from "../../../../packages/messengers/test/fake-tdlib.ts";
import { FakeLauncher, SKILLS, webcryptoVerifyApproval } from "../helpers.ts";
import { DISCORD_TOKEN, FakeGateway, fakeDiscordSdk, TG_APP } from "./messenger-login-harness.ts";

const port = Number(process.env.QA_MLOGIN_PORT ?? 8831);
if (port === 8787 || port === 5173) throw new Error("8787/5173 are the live preview: never use them for QA");

const dir = mkdtempSync(join(tmpdir(), "pickle-messenger-login-qa-"));
const db = openDatabase(join(dir, "pickle.db"));
const masterKey = crypto.getRandomValues(new Uint8Array(32));
const enclave = await Enclave.load({ dir: join(dir, "enclave"), masterKey });
const names = (id: string) => providers().find((p) => p.id === id)?.name ?? id;
const vault = new Vault({ enclave, masterKey, storage: db.vaultStorage() as never, serviceName: names });
const configRoot = join(dir, "messengers");

const td = new FakeTdJson({ twoFa: true });
const runtime = new TdRuntime(td);
const telegram = { ready: true };
const gateways: FakeGateway[] = [];
const exchange = { mode: "token" as "token" | "captcha" };

let appRef: App | null = null;
const hub = new MessengerHub({
  vault,
  storage: db.messengerStorage() as never,
  configRoot,
  onUpdate: (u, c) => appRef?.notifyConnection(u, c),
  sdk: {
    discord: async () => fakeDiscordSdk([]) as never,
    telegram: async () => ({ client: async () => runtime.client(), app: () => TG_APP }),
  },
});

// the provider list as the operator's server would answer it: telegram is "준비 중이에요" until api_id is configured
const qaProviders = () =>
  providers().map((p) => (p.id !== "telegram" ? p : telegram.ready ? { ...p, available: true, unavailableReason: undefined } : { ...p, available: false, unavailableReason: "준비 중이에요" }));

const app = createApp({
  db,
  launcher: new FakeLauncher(),
  vault: vault as never,
  enclave,
  hub,
  providers: qaProviders,
  runTurn: null,
  llm: null,
  skills: { listSkills: () => SKILLS, skillTools: () => [], skillCatalogForPrompt: () => "" },
  systemTools: () => [],
  verifyApproval: webcryptoVerifyApproval,
  messengerLogin: {
    configRoot,
    startsPerWindow: 500,
    pollMs: 1000,
    discordSocket: () => {
      const g = new FakeGateway();
      gateways.push(g);
      queueMicrotask(() => g.handshake());
      return g;
    },
    discordFetch: (async () => {
      const g = gateways[gateways.length - 1]!;
      if (exchange.mode === "captcha") return new Response(JSON.stringify({ captcha_sitekey: "k", captcha_key: ["captcha-required"] }), { status: 400 });
      return new Response(JSON.stringify({ encrypted_token: g.encrypt(DISCORD_TOKEN) }), { status: 200 });
    }) as unknown as typeof fetch,
    telegram: async () => (telegram.ready ? { ok: true, app: TG_APP, runtime } : { ok: false, reason: "not_configured" }),
  },
  config: { dataDir: dir, quiet: false, dev: true, sseHeartbeatMs: 15_000, eventsHeartbeatMs: 15_000 },
});
appRef = app;
app.start();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function qa(req: Request, path: string): Promise<Response> {
  const g = gateways[gateways.length - 1];
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  switch (path) {
    case "/qa/discord/scan":
      if (!g) return json({ error: "no gateway" }, 409);
      g.scan();
      return json({ ok: true });
    case "/qa/discord/approve":
      if (!g) return json({ error: "no gateway" }, 409);
      g.approve();
      return json({ ok: true });
    case "/qa/discord/reject":
      if (!g) return json({ error: "no gateway" }, 409);
      g.push({ op: "cancel" });
      return json({ ok: true });
    case "/qa/discord/expire":
      if (!g) return json({ error: "no gateway" }, 409);
      g.emit("close", 4003);
      return json({ ok: true });
    case "/qa/discord/exchange":
      exchange.mode = body.mode === "captcha" ? "captcha" : "token";
      return json({ ok: true, mode: exchange.mode });
    case "/qa/telegram":
      if (typeof body.ready === "boolean") telegram.ready = body.ready;
      if (typeof body.twoFa === "boolean") td.opts.twoFa = body.twoFa;
      return json({ ok: true, ready: telegram.ready, twoFa: !!td.opts.twoFa });
  }
  return json({ error: "not found" }, 404);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  fetch: (req, srv) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.startsWith("/qa/")) return qa(req, url.pathname);
    return app.fetch(req, srv);
  },
});
console.log(`QA_READY http://127.0.0.1:${server.port}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
