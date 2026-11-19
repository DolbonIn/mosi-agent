/**
 * createApp(deps) — the whole API server as a pure function of its dependencies.
 * Returns `{ fetch, scheduler, start, close, events, notifyConnection }`; src/main.ts builds the
 * real deps and hands `fetch` to Bun.serve. Tests pass in-file fakes.
 */
import type { Connection } from "@pickle/protocol";
import type { AppDeps, ServerConfig } from "./deps.ts";
import type { Core } from "./core.ts";
import { EventHub } from "./events.ts";
import { createLogger, errInfo } from "./log.ts";
import {
  corsHeaders,
  DEV_ORIGINS,
  errorResponse,
  HttpError,
  json,
  notFound,
  Router,
  SECURITY_HEADERS,
  withHeaders,
  type Ctx,
  type ServerLike,
} from "./http.ts";
import { authenticate, authRoutes, type AuthedUser } from "./auth.ts";
import { threadRoutes } from "./threads.ts";
import { exploreRoutes, seedTemplates } from "./explore.ts";
import { archiveRoutes } from "./archive.ts";
import { profileRoutes } from "./profile.ts";
import { myPhoneRoutes } from "./myphone.ts";
import { passwordResetRoutes } from "./passwordReset.ts";
import { connectionRoutes, credentialRoutes } from "./credentials.ts";
import { defaultConnections, stopKskill } from "./kskill.ts";
import { friendRoutes } from "./friends.ts";
import { scheduleRoutes, Scheduler } from "./schedules.ts";
import { uiDefinitions } from "./sdui.ts";
import { createStatic } from "./static.ts";
import { createTts } from "./tts.ts";
import { createVoiceIo, ttsRoutes } from "./audio.ts";
import { MeetHub } from "./meet.ts";
import { meetRoutes } from "./meetRoutes.ts";
import { SlackLoginRelay } from "./slack-login/relay.ts";
import { loginRelayRoutes } from "./slack-login/routes.ts";
import { MessengerLoginRelay } from "./messenger-login/relay.ts";
import { isLoginProvider, messengerLoginRoutes } from "./messenger-login/routes.ts";
import { DEFAULT_DAILY_TOKENS } from "@pickle/protocol";

export const SERVER_VERSION = "0.3.0";

export function resolveConfig(c: Partial<ServerConfig> = {}): ServerConfig {
  return {
    dataDir: c.dataDir ?? ".data",
    version: c.version ?? SERVER_VERSION,
    publicOrigin: c.publicOrigin ?? null,
    dev: c.dev ?? false,
    staticDir: c.staticDir ?? null,
    dailyTokens: c.dailyTokens ?? DEFAULT_DAILY_TOKENS,
    trustProxy: c.trustProxy ?? false,
    twilio: c.twilio ?? null,
    tts: c.tts ?? null,
    meet: c.meet ?? null,
    stt: c.stt ?? null,
    passwordCost: c.passwordCost ?? null,
    authRatePerMinute: c.authRatePerMinute ?? 10,
    turnIdleTimeoutMs: c.turnIdleTimeoutMs ?? 60_000,
    turnMaxMs: c.turnMaxMs ?? 5 * 60_000,
    turnSettleMs: c.turnSettleMs ?? 3_000,
    connectionWaitMs: c.connectionWaitMs ?? 90_000,
    connectionRecheckMs: c.connectionRecheckMs ?? [30_000, 120_000, 600_000],
    // 쿠팡 파트너스 verifies with a real search (about 10 per key per hour): at most one re-check an hour
    connectionRecheckFloorMs: c.connectionRecheckFloorMs ?? { "coupang-partners": 3_600_000 },
    schedulerIntervalMs: c.schedulerIntervalMs ?? 30_000,
    sseHeartbeatMs: c.sseHeartbeatMs ?? 15_000,
    eventsHeartbeatMs: c.eventsHeartbeatMs ?? 25_000,
    quiet: c.quiet ?? false,
  };
}

/** Never log tokens: invite tokens live in /i/<token> and /api/invites/<token>/accept. */
function redactPath(p: string): string {
  return p.replace(/^\/i\/[^/]+/, "/i/:token").replace(/^\/api\/invites\/[^/]+\/accept/, "/api/invites/:token/accept");
}

export interface App {
  fetch(req: Request, server?: ServerLike): Promise<Response>;
  scheduler: Scheduler;
  start(): void;
  close(): Promise<void>;
  events: EventHub;
  core: Core;
  /** wire into MessengerHub's onUpdate */
  notifyConnection(userId: string, c: Connection): void;
}

export function createApp(deps: AppDeps): App {
  const cfg = resolveConfig(deps.config);
  const log = createLogger({ quiet: cfg.quiet });
  const now = () => (deps.clock ? deps.clock.now() : Date.now());
  const pending = new Set<Promise<unknown>>();
  const events = new EventHub(cfg.eventsHeartbeatMs, now);
  const core: Core = {
    deps,
    db: deps.db,
    cfg,
    events,
    log,
    now,
    track(p) {
      const t = p.catch((err) => log.error("background task failed", { err: errInfo(err) })).finally(() => pending.delete(t));
      pending.add(t);
    },
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    activeTurns: new Map(),
    voice: createVoiceIo(createTts(cfg, { log, now }), now),
    meet: undefined as unknown as MeetHub,
    connections: deps.connections ?? defaultConnections(deps, now),
  };
  core.meet = new MeetHub(core);

  seedTemplates(core);
  const scheduler = new Scheduler(core);
  const staticHandler = createStatic(cfg.staticDir);

  const auth = authRoutes(core);
  const reset = passwordResetRoutes(core);
  const threads = threadRoutes(core);
  const explore = exploreRoutes(core);
  const archive = archiveRoutes(core);
  const profile = profileRoutes(core);
  const myPhone = myPhoneRoutes(core);
  const creds = credentialRoutes(core);
  const conns = connectionRoutes(core);
  const friends = friendRoutes(core);
  const schedules = scheduleRoutes(core);
  const speech = ttsRoutes(core);
  const meeting = meetRoutes(core);
  const slackLogin = new SlackLoginRelay(core, deps.slackLogin);
  const loginRelay = loginRelayRoutes(core, slackLogin);
  const messengerLogin = new MessengerLoginRelay(core, deps.messengerLogin);
  const messengerLoginRelay = messengerLoginRoutes(core, messengerLogin);

  type UserHandler = (c: Ctx, userId: string) => Promise<Response> | Response;
  const authed =
    (h: UserHandler, allowQuery = false) =>
    (c: Ctx) => {
      const a = authenticate(core, c.req, c.url, allowQuery);
      if (!a || !core.db.userById(a.userId)) throw new HttpError(401, "unauthorized", "다시 로그인해 주세요");
      return h(c, a.userId);
    };
  const authedFull = (h: (c: Ctx, a: AuthedUser) => Promise<Response> | Response) => (c: Ctx) => {
    const a = authenticate(core, c.req, c.url, false);
    if (!a || !core.db.userById(a.userId)) throw new HttpError(401, "unauthorized", "다시 로그인해 주세요");
    return h(c, a);
  };

  /** k-skill proxy counters for /api/health: numeric fields only (no URLs, no user data) */
  const skillStats = (): Record<string, number> | null => {
    try {
      const raw = deps.skills.httpStats?.();
      if (!raw) return null;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      return out;
    } catch {
      return null;
    }
  };

  /** TTS reachability from the last probe; a stale/missing probe is refreshed in the background (never blocks) */
  const ttsHealth = (): "configured" | "missing" => {
    const tts = core.voice.tts;
    if (!tts) return "missing";
    if (now() - tts.checkedAt() > 30_000) void tts.available();
    return tts.status() ? "configured" : "missing";
  };

  const r = new Router();
  r.on("GET", "/api/health", () =>
    json({
      ok: core.db.ping(),
      llm: deps.runTurn ? "configured" : "missing",
      model: deps.llm?.model ?? null,
      version: cfg.version,
      db: core.db.ping() ? "ok" : "error",
      schema: core.db.schemaVersion,
      packages: deps.packages ?? {},
      skills: skillStats(),
      tts: ttsHealth(),
      publicAudio: core.voice.publicBase() ? "ready" : "missing",
      ...core.meet.health(),
    }),
  );
  // auth
  r.on("POST", "/api/auth/signup", auth.signup);
  r.on("POST", "/api/auth/login", auth.login);
  r.on("POST", "/api/auth/logout", authedFull(auth.logout));
  r.on("POST", "/api/auth/reset/start", reset.start);
  r.on("POST", "/api/auth/reset/verify", reset.verify);
  r.on("GET", "/api/session", authedFull(auth.session));
  r.on("GET", "/api/ui-definitions", (c) => {
    const a = authenticate(core, c.req, c.url, false);
    const u = a ? core.db.userById(a.userId) : null;
    return json(uiDefinitions(u?.agent_name ?? "모시"));
  });
  r.on(
    "GET",
    "/api/events",
    authed((c, userId) => {
      try {
        c.server?.timeout?.(c.req, 0);
      } catch {
        /* older Bun */
      }
      return events.subscribe(userId, c.req.signal);
    }, true),
  );
  // threads & messages
  r.on("GET", "/api/threads", authed(threads.list));
  r.on("POST", "/api/threads", authed(threads.create));
  r.on("PATCH", "/api/threads/:id", authed(threads.patch));
  r.on("GET", "/api/threads/:id/messages", authed(threads.messages));
  r.on("POST", "/api/threads/:id/messages", authed(threads.send));
  // the call cut a spoken reply off: its history keeps only what was heard
  r.on("POST", "/api/threads/:id/messages/:messageId/heard", authed(threads.heard));
  // the meeting behind a '회의 참여' thread; take 모시 out of it
  r.on("GET", "/api/threads/:id/meet", authed(meeting.get));
  r.on("POST", "/api/threads/:id/meet/leave", authed(meeting.leave));
  r.on("POST", "/api/approvals/:id", authed(threads.decide));
  // explore
  r.on("GET", "/api/explore", authed(explore.explore));
  r.on("POST", "/api/explore/:templateId/delegate", authed(explore.delegate));
  // archive
  r.on("GET", "/api/artifacts", authed(archive.listArtifacts));
  r.on("GET", "/api/artifacts/:id", authed(archive.getArtifact));
  r.on("DELETE", "/api/artifacts/:id", authed(archive.deleteArtifact));
  r.on("GET", "/api/blobs/:id", authed(archive.blob, true));
  r.on("POST", "/api/attachments", authed(archive.upload));
  r.on("GET", "/api/attachments", authed(archive.listAttachments));
  r.on("GET", "/api/attachments/:id/raw", authed(archive.raw, true));
  r.on("DELETE", "/api/attachments/:id", authed(archive.deleteAttachment));
  // profile
  r.on("GET", "/api/profile", authed(profile.profile));
  r.on("POST", "/api/tickets/use", authed(profile.useTicket));
  r.on("PATCH", "/api/settings", authed(profile.patchSettings));
  r.on("GET", "/api/agent", authed(profile.getAgent));
  r.on("PATCH", "/api/agent", authed(profile.patchAgent));
  r.on("POST", "/api/agent/restart", authed(profile.restartAgent));
  r.on("GET", "/api/skills", authed(profile.skills));
  r.on("GET", "/api/memories", authed(profile.memories));
  r.on("DELETE", "/api/memories/:id", authed(profile.forget));
  // 나의 모시 > 내 전화번호 (verified by a call; unlocks sys_call_me)
  r.on("PUT", "/api/profile/phone", authed(myPhone.register));
  r.on("POST", "/api/profile/phone/verify", authed(myPhone.verify));
  r.on("DELETE", "/api/profile/phone", authed(myPhone.remove));
  // credential enclave
  r.on("GET", "/api/enclave", authed(creds.enclave));
  r.on("GET", "/api/credentials", authed(creds.list));
  r.on("POST", "/api/credentials", authed(creds.save));
  r.on("PATCH", "/api/credentials/:id", authed(creds.patch));
  r.on("DELETE", "/api/credentials/:id", authed(creds.remove));
  r.on("GET", "/api/access-log", authed(creds.accessLog));
  // connections
  r.on("GET", "/api/connections", authed(conns.list));
  r.on("POST", "/api/connections/:provider", authed(conns.connect));
  r.on("POST", "/api/connections/:provider/verify", authed(conns.verify));
  r.on("DELETE", "/api/connections/:provider", authed(conns.disconnect));
  r.on("GET", "/api/connections/:provider/chats", authed(conns.chats));
  // in-app sign-in relay (Slack): sealed email/code/password → throwaway browser → vault
  // Discord (remote auth) / Telegram (phone login): same protocol, messenger-login/relay.ts
  const relayFor = (slack: UserHandler, other: UserHandler): UserHandler => (c, userId) => (isLoginProvider(c.params.provider) ? other(c, userId) : slack(c, userId));
  r.on("POST", "/api/connections/:provider/login", authed(relayFor(loginRelay.start, messengerLoginRelay.start)));
  r.on("POST", "/api/connections/:provider/login/step", authed(relayFor(loginRelay.step, messengerLoginRelay.step)));
  r.on("POST", "/api/connections/:provider/login/cancel", authed(relayFor(loginRelay.cancel, messengerLoginRelay.cancel)));
  // friends & invites
  r.on("GET", "/api/friends", authed(friends.list));
  r.on("POST", "/api/friends/:userId/block", authed(friends.block));
  r.on("DELETE", "/api/friends/:userId", authed(friends.remove));
  r.on("POST", "/api/invites", authed(friends.createInvite));
  r.on("POST", "/api/invites/:token/accept", authed(friends.accept));
  r.on("GET", "/i/:token", friends.landing);
  // schedules
  r.on("GET", "/api/schedules", authed(schedules.list));
  r.on("POST", "/api/schedules", authed(schedules.create));
  r.on("PATCH", "/api/schedules/:id", authed(schedules.patch));
  r.on("DELETE", "/api/schedules/:id", authed(schedules.remove));
  // voice (call screen): local Drama-3 TTS → audio/mpeg; 503 tts_unavailable → client falls back to Web Speech
  r.on("POST", "/api/tts", authed(speech.speak));
  r.on("POST", "/api/tts/stream", authed(speech.stream));

  let housekeeping: ReturnType<typeof setInterval> | null = null;

  async function fetch(req: Request, server?: ServerLike): Promise<Response> {
    const started = performance.now();
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return withHeaders(json({ error: "bad_request", message: "잘못된 요청이에요" }, 400), SECURITY_HEADERS);
    }
    const origin = req.headers.get("origin");
    const cors = cfg.dev && origin && DEV_ORIGINS.has(origin) ? corsHeaders(origin) : null;
    const fwd = cfg.trustProxy ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
    let ip = fwd || "unknown";
    if (!fwd) {
      try {
        ip = server?.requestIP?.(req)?.address ?? "unknown";
      } catch {
        ip = "unknown";
      }
    }
    const isApi = url.pathname.startsWith("/api/") || url.pathname === "/api" || url.pathname.startsWith("/i/");
    let res: Response;
    try {
      if (req.method === "OPTIONS") {
        res = new Response(null, { status: 204 });
      } else if (isApi) {
        const m = r.match(req.method, url.pathname);
        if (m === "none") throw notFound("없는 주소예요");
        if (m === "method") throw new HttpError(405, "method_not_allowed", "지원하지 않는 요청이에요");
        res = await m.handler({ req, url, params: m.params, ip, server });
      } else {
        res =
          (staticHandler ? await staticHandler(url.pathname, req.method) : null) ??
          new Response("페이지를 찾을 수 없어요", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    } catch (err) {
      if (err instanceof HttpError) res = errorResponse(err);
      else {
        log.error("unhandled", { method: req.method, path: redactPath(url.pathname), err: errInfo(err) });
        res = json({ error: "internal", message: "서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요." }, 500);
      }
    }
    res = withHeaders(res, cors ? { ...SECURITY_HEADERS, ...cors } : SECURITY_HEADERS);
    if (isApi && url.pathname !== "/api/health") {
      log.info("http", { method: req.method, path: redactPath(url.pathname), status: res.status, ms: Math.round(performance.now() - started) });
    }
    return res;
  }

  return {
    fetch,
    scheduler,
    events,
    core,
    start() {
      scheduler.start();
      void core.voice.tts?.available(); // non-blocking startup probe for /api/health
      core.meet.start(); // follow meetings that were still running before a restart
      housekeeping ??= setInterval(() => {
        try {
          const n = core.db.purgeExpiredSessions(now());
          if (n) log.info("sessions purged", { n });
        } catch (err) {
          log.warn("housekeeping failed", { err: errInfo(err) });
        }
      }, 6 * 60 * 60 * 1000);
    },
    async close() {
      scheduler.stop();
      if (housekeeping) clearInterval(housekeeping);
      housekeeping = null;
      events.closeAll();
      await slackLogin.close();
      await messengerLogin.close();
      await core.meet.close();
      stopKskill(core);
      await Promise.race([core.idle(), new Promise((res) => setTimeout(res, 5_000))]);
      try {
        await deps.hub.shutdown();
      } catch (err) {
        log.warn("hub shutdown failed", { err: errInfo(err) });
      }
      try {
        core.db.close();
      } catch {
        /* already closed */
      }
    },
    notifyConnection(userId, c) {
      events.publish(userId, { type: "connection", connection: c });
    },
  };
}

export type { AppDeps, ServerConfig };
