/**
 * Builds the real dependencies from the environment and starts Bun.serve.
 * Packages are loaded with dynamic imports so a missing/unfinished package is reported precisely
 * (and optional ones degrade gracefully) instead of crashing with an opaque module error.
 * Never logs secret values.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderInfo, SkillInfo } from "@pickle/protocol";
import type { ConnectionService, RunTurn, ToolDef, TurnOutcome } from "@pickle/agent";
import { createApp, SERVER_VERSION, type App } from "./app.ts";
import { openDatabase, type Db } from "./db/index.ts";
import type { AppDeps, ConnectionsLike, EnclaveLike, HubLike, LauncherLike, LlmHelpers, SkillsLike, VaultLike } from "./deps.ts";
import { createLogger, errInfo } from "./log.ts";
import { CHAT_MAX_TOKENS, chatToolTimeoutMs, deepSearchOn, thinkingMode, withThinking } from "./llm-policy.ts";
import { ttsUrlFromEnv } from "./tts.ts";
import { startPublicAudio } from "./audio.ts";
import {
  DEFAULT_MEET_BOT_URL,
  DEFAULT_STT_URL,
  idleMsFromEnv,
  meetModelFromEnv,
  plainChat,
  serviceUrlFromEnv,
  turnHoldMsFromEnv,
  yieldSyllablesFromEnv,
} from "./meet.ts";
import { addresseeBackendFromEnv, chatClassifier, deciderClassifier, withFallback } from "./meetAddressee.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const log = createLogger();

type Mod = Record<string, unknown>;

function decodeMasterKey(raw: string | undefined, dataDir: string, production: boolean): Uint8Array {
  if (raw && raw.trim()) {
    const bytes = Buffer.from(raw.trim(), "base64");
    if (bytes.length !== 32) throw new Error("VAULT_MASTER_KEY must be 32 bytes (base64)");
    return new Uint8Array(bytes);
  }
  if (production) throw new Error("VAULT_MASTER_KEY is required in production");
  // dev only: a per-data-dir key file so local data stays readable across restarts
  const file = join(dataDir, "dev-vault-master.key");
  if (existsSync(file)) return new Uint8Array(Buffer.from(readFileSync(file, "utf8").trim(), "base64"));
  const key = crypto.getRandomValues(new Uint8Array(32));
  writeFileSync(file, Buffer.from(key).toString("base64"), { mode: 0o600 });
  log.warn("VAULT_MASTER_KEY missing — generated a dev key file in the data dir (never use in production)");
  return key;
}

export interface BuiltDeps {
  deps: AppDeps;
  db: Db;
  bindApp(app: App): void;
}

export async function buildDeps(env: Record<string, string | undefined> = process.env): Promise<BuiltDeps> {
  const production = env.NODE_ENV === "production";
  const dataDir = resolve(env.PICKLE_DATA_DIR ?? join(REPO_ROOT, ".data"));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(dataDir, "pickle.db"));
  const packages: Record<string, string> = {};

  const load = async (name: string): Promise<Mod | null> => {
    try {
      const m = (await import(name)) as Mod;
      packages[name] = "ok";
      return m;
    } catch (err) {
      packages[name] = `import failed: ${errInfo(err)}`;
      log.error("package import failed", { pkg: name, err: errInfo(err) });
      return null;
    }
  };
  const need = <T>(mod: Mod | null, pkg: string, name: string): T => {
    const v = mod?.[name];
    if (v === undefined) {
      packages[pkg] = mod ? `missing export: ${name}` : packages[pkg] ?? "not loaded";
      throw new Error(`${pkg} does not export ${name} (see docs/architecture/PACKAGES.md)`);
    }
    return v as T;
  };
  const optional = <T>(mod: Mod | null, pkg: string, name: string): T | null => {
    const v = mod?.[name];
    if (v === undefined && mod) packages[pkg] = `missing export: ${name}`;
    return (v as T) ?? null;
  };

  const agentMod = await load("@pickle/agent");
  const launcherMod = await load("@pickle/launcher");
  const vaultMod = await load("@pickle/vault");
  const messengersMod = await load("@pickle/messengers");
  const skillsMod = await load("@pickle/skills");

  // ── LLM (optional: without a key the server runs, turns answer 503) ──
  let runTurn: RunTurn | null = null;
  let llm: LlmHelpers | null = null;
  let model = env.OPENGATEWAY_MODEL ?? "deepseek/deepseek-v4.1-flash-ultrafast";
  let systemTools: () => ToolDef[] = () => [];
  let partialOutcome: ((err: unknown) => TurnOutcome | null) | undefined;
  if (agentMod) {
    const loadLlmConfig = optional<(e: Record<string, string | undefined>) => { model: string }>(agentMod, "@pickle/agent", "loadLlmConfig");
    const LlmClient = optional<new (cfg: unknown) => { model: string }>(agentMod, "@pickle/agent", "LlmClient");
    const createRunTurn = optional<(c: unknown, o?: { toolTimeoutMs?: number; maxTokens?: number; deepSearch?: boolean }) => RunTurn>(agentMod, "@pickle/agent", "createRunTurn");
    const extractMemories = optional<(c: unknown, i: unknown) => Promise<string[]>>(agentMod, "@pickle/agent", "extractMemories");
    const titleFor = optional<(c: unknown, t: string) => Promise<string>>(agentMod, "@pickle/agent", "titleFor");
    const sysTools = optional<() => ToolDef[]>(agentMod, "@pickle/agent", "systemTools");
    if (sysTools) systemTools = sysTools;
    partialOutcome = optional<(err: unknown) => TurnOutcome | null>(agentMod, "@pickle/agent", "partialOutcome") ?? undefined;
    if (loadLlmConfig && LlmClient && createRunTurn) {
      try {
        const cfg = loadLlmConfig(env);
        const client = new LlmClient(cfg);
        model = client.model;
        // chat turns skip hidden reasoning unless PICKLE_TURN_THINKING=on (see llm-policy.ts)
        const thinking = thinkingMode(env.PICKLE_TURN_THINKING);
        // a hung tool ends at its deadline (25 s), well before the 60 s turn idle watchdog: the model still answers
        // CHAT_MAX_TOKENS: room for an html artifact's fragment in one tool call (see llm-policy.ts)
        runTurn = createRunTurn(withThinking(client, thinking), { toolTimeoutMs: chatToolTimeoutMs(env.PICKLE_TOOL_TIMEOUT_MS), maxTokens: CHAT_MAX_TOKENS, deepSearch: deepSearchOn(env.PICKLE_DEEP_SEARCH) });
        // meeting answers must start speaking within ~1 s: their own (fast) model, see meet.ts
        const meetModel = meetModelFromEnv(env.PICKLE_MEET_MODEL);
        const meetClient = meetModel === model ? client : new LlmClient({ ...cfg, model: meetModel });
        const meetChat = plainChat(meetClient as unknown as Parameters<typeof plainChat>[0]);
        // conversation mode in meetings: who an unnamed line is for (decider-4b by default, the chat model as fallback)
        const backend = addresseeBackendFromEnv(env.PICKLE_MEET_ADDRESSEE);
        const cfgUrl = cfg as unknown as { baseUrl: string; apiKey: string };
        const decider = deciderClassifier({ baseUrl: cfgUrl.baseUrl, apiKey: cfgUrl.apiKey });
        const chatCls = chatClassifier(meetChat);
        const addressee = backend === "off" ? undefined : backend === "decider" ? withFallback(decider, chatCls) : withFallback(chatCls, decider);
        log.info("llm", { model, turnThinking: thinking, meetModel, meetAddressee: backend });
        llm = {
          model,
          extractMemories: (i) => (extractMemories ? extractMemories(client, i) : Promise.resolve([])),
          titleFor: (t) => (titleFor ? titleFor(client, t) : Promise.resolve("")),
          chat: meetChat,
          addressee,
          meetClient: withThinking(meetClient, "off") as unknown as LlmHelpers["meetClient"],
        };
      } catch (err) {
        log.warn("LLM not configured", { reason: errInfo(err) });
      }
    }
  }

  // ── launcher (required) ──
  const AgentLauncher = need<new (o: { rootDir: string; model: string }) => LauncherLike>(launcherMod, "@pickle/launcher", "AgentLauncher");
  const launcher = new AgentLauncher({ rootDir: join(dataDir, "agents"), model });

  // ── messengers providers (optional) ──
  const providersFn = optional<() => ProviderInfo[]>(messengersMod, "@pickle/messengers", "providers");
  const providers = () => {
    try {
      return providersFn ? providersFn() : [];
    } catch {
      return [];
    }
  };

  // ── k-skill login catalog (optional → none): 팝빌, 토스증권 … (docs/architecture/KSKILL-CONNECTIONS.md) ──
  // not `optional()`: a @pickle/skills without the export just has no catalog yet, which is not a degraded package
  const connectionServicesFn = typeof skillsMod?.connectionServices === "function" ? (skillsMod.connectionServices as () => ConnectionService[]) : null;
  const connectionServices = (): ConnectionService[] => {
    try {
      return connectionServicesFn?.() ?? [];
    } catch {
      return [];
    }
  };

  // ── vault (required) ──
  const masterKey = decodeMasterKey(env.VAULT_MASTER_KEY, dataDir, production);
  const EnclaveCls = need<{ load(o: { dir: string; masterKey: Uint8Array }): Promise<EnclaveLike> }>(vaultMod, "@pickle/vault", "Enclave");
  const VaultCls = need<new (o: { enclave: EnclaveLike; masterKey: Uint8Array; storage: unknown; serviceName: (id: string) => string }) => VaultLike>(
    vaultMod,
    "@pickle/vault",
    "Vault",
  );
  const verifyApproval = need<AppDeps["verifyApproval"]>(vaultMod, "@pickle/vault", "verifyApproval");
  const enclave = await EnclaveCls.load({ dir: join(dataDir, "enclave"), masterKey });
  const SERVICE_NAMES: Record<string, string> = { phone: "전화", pickle: "모시", naver: "네이버", google: "Google" };
  const vault = new VaultCls({
    enclave,
    masterKey,
    storage: db.vaultStorage(),
    // the access log names k-skill services too ("팝빌")
    serviceName: (id) => providers().find((p) => p.id === id)?.name ?? connectionServices().find((s) => s.id === id)?.name ?? SERVICE_NAMES[id] ?? id,
  });

  // ── k-skill connections: verify after save, sessions, in-turn connect waits, revoke ──
  const RegistryCls = optional<new (o: { vault: VaultLike; services: () => ConnectionService[] }) => ConnectionsLike>(agentMod, "@pickle/agent", "ConnectionRegistry");
  const connections = RegistryCls ? new RegistryCls({ vault, services: connectionServices }) : undefined;

  // ── hub (optional → stub) ──
  let appRef: App | null = null;
  let hub: HubLike;
  const HubCls = optional<new (o: unknown) => HubLike>(messengersMod, "@pickle/messengers", "MessengerHub");
  if (HubCls) {
    hub = new HubCls({
      vault,
      storage: db.messengerStorage(),
      configRoot: join(dataDir, "messengers"),
      onUpdate: (userId: string, c: unknown) => appRef?.notifyConnection(userId, c as never),
    });
  } else {
    const storage = db.messengerStorage();
    const unavailable = () => Promise.reject(new Error("메신저 연결 기능을 아직 쓸 수 없어요"));
    hub = {
      connect: unavailable,
      verify: unavailable,
      disconnect: (u, p) => storage.deleteConnection(u, p),
      connections: (u) => storage.listConnections(u),
      listChats: unavailable,
      tools: () => [],
      shutdown: async () => {},
    };
  }

  // ── skills (optional → empty) ──
  const skills: SkillsLike = {
    listSkills: optional<() => SkillInfo[]>(skillsMod, "@pickle/skills", "listSkills") ?? (() => []),
    skillTools: optional<(e?: string[]) => ToolDef[]>(skillsMod, "@pickle/skills", "skillTools") ?? (() => []),
    skillCatalogForPrompt: optional<(e?: string[]) => string>(skillsMod, "@pickle/skills", "skillCatalogForPrompt") ?? (() => ""),
    httpStats: optional<() => Record<string, unknown>>(skillsMod, "@pickle/skills", "httpStats") ?? undefined,
    connectionServices,
  };

  // TWILIO_FROM is optional: without it, use the account's first voice-capable number (if it has one)
  const twilioFrom = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? (env.TWILIO_FROM?.trim() || (await firstTwilioVoiceNumber(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN))) : null;
  const twilio =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && twilioFrom
      ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: twilioFrom }
      : null;
  if (env.TWILIO_ACCOUNT_SID && !twilio) console.warn("[pickle/server] twilio credentials set but the account has no voice number (set TWILIO_FROM or buy a number)");

  // local Drama-3 TTS (services/tts): PICKLE_TTS_URL, default http://127.0.0.1:8790, "off" disables
  const ttsUrl = ttsUrlFromEnv(env.PICKLE_TTS_URL);
  // Google Meet browser bot (services/meet) and local STT (services/stt); "off" disables
  const meetUrl = serviceUrlFromEnv(env.MEET_BOT_URL, DEFAULT_MEET_BOT_URL);
  const sttUrl = serviceUrlFromEnv(env.STT_URL, DEFAULT_STT_URL);

  const deps: AppDeps = {
    db,
    launcher,
    vault,
    enclave,
    hub,
    providers,
    runTurn,
    partialOutcome,
    llm,
    skills,
    systemTools,
    verifyApproval,
    packages,
    ...(connections ? { connections } : {}),
    config: {
      dataDir,
      version: SERVER_VERSION,
      publicOrigin: env.PUBLIC_ORIGIN?.trim() || null,
      dev: !production,
      staticDir: resolve(REPO_ROOT, "apps/mobile/dist"),
      dailyTokens: env.PICKLE_DAILY_TOKENS ? Math.max(1000, Number(env.PICKLE_DAILY_TOKENS) || 0) : undefined,
      trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
      twilio,
      tts: ttsUrl ? { url: ttsUrl } : null,
      meet: meetUrl
        ? {
            url: meetUrl,
            conversationIdleMs: idleMsFromEnv(env.MEET_CONVERSATION_IDLE_MS),
            turnHoldMs: turnHoldMsFromEnv(env.MEET_TURN_HOLD_MS),
            yieldSyllables: yieldSyllablesFromEnv(env.MEET_YIELD_SYLLABLES),
          }
        : null,
      stt: sttUrl ? { url: sttUrl } : null,
    },
  };
  return { deps, db, bindApp: (app) => (appRef = app) };
}

export async function main(): Promise<void> {
  const env = process.env;
  let built: BuiltDeps;
  try {
    built = await buildDeps(env);
  } catch (err) {
    log.error("startup failed", { err: errInfo(err) });
    process.exit(1);
  }
  // repair agent dirs for every user (never deletes); failures must not block startup
  try {
    const ids = built.db.allUserIds();
    const r = (await built.deps.launcher.reconcile?.(ids)) as { created?: string[]; repaired?: string[] } | undefined;
    log.info("agents reconciled", { users: ids.length, created: r?.created?.length ?? 0, repaired: r?.repaired?.length ?? 0 });
  } catch (err) {
    log.warn("agent reconcile failed", { err: errInfo(err) });
  }
  const app = createApp(built.deps);
  built.bindApp(app);
  app.start();

  const port = Number(env.PORT ?? 8787);
  const hostname = env.HOST ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 120,
    maxRequestBodySize: 12 * 1024 * 1024,
    fetch: (req, srv) => app.fetch(req, srv),
  });
  const pk = Object.entries(built.deps.packages ?? {})
    .map(([k, v]) => `${k.replace("@pickle/", "")}=${v === "ok" ? "ok" : "degraded"}`)
    .join(",");
  log.info("listening", {
    url: `http://${server.hostname}:${server.port}`,
    llm: built.deps.runTurn ? "configured" : "missing",
    model: built.deps.llm?.model ?? null,
    twilio: built.deps.config?.twilio ? "configured" : "missing",
    tts: built.deps.config?.tts ? "on" : "off",
    meet: built.deps.config?.meet ? "on" : "off",
    packages: pk,
  });
  // public audio for Twilio <Play> (separate 127.0.0.1 listener + optional cloudflared tunnel; non-blocking)
  // the tunnel is kept across restarts (audio-tunnel.json in the data dir): a restart reuses its URL
  const publicAudio = startPublicAudio(app.core.voice, { env, twilio: !!built.deps.config?.twilio, log, stateDir: built.deps.config?.dataDir });

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal: sig });
    server.stop();
    await publicAudio.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

/** The account's first voice-capable phone number (E.164), or null. Never logs credentials or numbers. */
async function firstTwilioVoiceNumber(sid: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?PageSize=20`, {
      headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { incoming_phone_numbers?: { phone_number?: string; capabilities?: { voice?: boolean } }[] };
    return data.incoming_phone_numbers?.find((n) => n.capabilities?.voice && n.phone_number)?.phone_number ?? null;
  } catch {
    return null;
  }
}
