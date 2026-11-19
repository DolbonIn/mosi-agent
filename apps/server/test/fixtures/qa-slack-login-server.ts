/**
 * QA server for the Slack 로그인 screens (apps/mobile/qa/slack-login.spec.mjs). NEVER a real Slack account:
 *   - a throwaway data dir (temp, deleted on exit), its own port (QA_SLACK_PORT, default 8823)
 *   - the relay drives real headless Chrome against the local fake Slack site (fixtures/fake-slack.ts)
 *   - the REAL vault + enclave + MessengerHub; only Slack's Web API is a local fake (auth.test accepts fake tokens)
 * Run from the repo root: bun run apps/server/test/fixtures/qa-slack-login-server.ts
 * Prints `QA_READY <api> <fake-slack>` when listening. Logs go to stdout so the spec can grep them for secrets.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Enclave, Vault } from "@pickle/vault";
import { MessengerHub, providers } from "@pickle/messengers";
import { createApp, type App } from "../../src/app.ts";
import { openDatabase } from "../../src/db/index.ts";
import { startFakeSlack } from "./fake-slack.ts";
import { fakeSlackSdk, startFakeSlackApi, type FakeSlackSdkState } from "./relay-harness.ts";
import { FakeLauncher, SKILLS, webcryptoVerifyApproval } from "../helpers.ts";

const port = Number(process.env.QA_SLACK_PORT ?? 8823);
if (port === 8787 || port === 5173) throw new Error("8787/5173 are the live preview: never use them for QA");

const dir = mkdtempSync(join(tmpdir(), "pickle-slack-login-qa-"));
const fake = startFakeSlack();
const db = openDatabase(join(dir, "pickle.db"));
const masterKey = crypto.getRandomValues(new Uint8Array(32));
const enclave = await Enclave.load({ dir: join(dir, "enclave"), masterKey });
const names = (id: string) => providers().find((p) => p.id === id)?.name ?? id;
const vault = new Vault({ enclave, masterKey, storage: db.vaultStorage() as never, serviceName: names });
const slack: FakeSlackSdkState = { logins: [], accept: /^xoxc-FAKE-/ };
const slackApi = startFakeSlackApi(slack, `${fake.base}/api`);
let appRef: App | null = null;
const hub = new MessengerHub({
  vault,
  storage: db.messengerStorage() as never,
  configRoot: join(dir, "messengers"),
  onUpdate: (u, c) => appRef?.notifyConnection(u, c),
  sdk: { slack: async () => fakeSlackSdk(slackApi.url) as never },
});

const app = createApp({
  db,
  launcher: new FakeLauncher(),
  vault: vault as never,
  enclave,
  hub,
  providers,
  runTurn: null,
  llm: null,
  skills: { listSkills: () => SKILLS, skillTools: () => [], skillCatalogForPrompt: () => "" },
  systemTools: () => [],
  verifyApproval: webcryptoVerifyApproval,
  slackLogin: { urls: fake.urls, maxConcurrent: 4, startsPerWindow: 200 },
  config: { dataDir: dir, quiet: false, dev: true, sseHeartbeatMs: 15_000, eventsHeartbeatMs: 15_000 },
});
appRef = app;
app.start();

const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 120, fetch: (req, srv) => app.fetch(req, srv) });
console.log(`QA_READY http://127.0.0.1:${server.port} ${fake.base}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await app.close();
  slackApi.stop();
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
