// services/meet HTTP API (계약 §2). 127.0.0.1에만 바인딩, 한 번에 회의 하나.
//   bun services/meet/server.ts   (또는 services/meet/start.sh)
import { config as defaultConfig, type Config } from "./config";
import { log } from "./log";
import type { TranscriptEvent } from "./listen";
import { chromeInstalled, Session, type SessionEvent } from "./session";
import { SSE_HEADERS, SSE_PING, sseEvent } from "./sse";
import { serviceHealth } from "./stt";
import { parseMeetUrl } from "./url";

/** 서버가 세션에 기대는 최소 모양(테스트에서 가짜로 바꿔 끼운다) */
export interface SessionLike {
  readonly id: string;
  readonly state: Session["state"];
  readonly active: boolean;
  snapshot(): ReturnType<Session["snapshot"]>;
  debugStats?(): unknown;
  debugPage?(): Promise<unknown>;
  subscribe(fn: (e: SessionEvent) => void): () => void;
  start(): void;
  sayText(text: string): string;
  /** 캐시된 맞장구 소리로 바로 말하기. 캐시에 없으면 null */
  sayCached?(text: string): string | null;
  stopSaying(): Promise<number>;
  leave(): Promise<Session["state"]>;
  done(): Promise<void>;
  readonly endReason?: string;
  nextCapturedLoud?(timeoutMs: number): Promise<number | null>;
  /** 다시 붙은 구독자에게 seq > since 인 transcript를 다시 보낸다 */
  transcriptsSince?(since: number): TranscriptEvent[];
}

export interface AppDeps {
  makeSession: (init: { id: string; url: string; code: string; name: string; announce?: string; sttPrompt?: string; loopback?: boolean }) => SessionLike;
  health?: () => Promise<{ chrome: "ready" | "missing"; stt: "ready" | "down"; tts: "ready" | "down" }>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const err = (status: number, code: string) => json(status, { error: code });

function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return `m_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createApp(cfg: Config, deps: AppDeps) {
  const sessions = new Map<string, SessionLike>();
  const order: string[] = [];
  let current: SessionLike | null = null;

  const remember = (s: SessionLike) => {
    sessions.set(s.id, s);
    order.push(s.id);
    while (order.length > 20) {
      const old = order.shift()!;
      if (sessions.get(old)?.active) {
        order.push(old);
        break;
      }
      sessions.delete(old);
    }
  };

  const health =
    deps.health ??
    (async () => {
      const [stt, tts] = await Promise.all([serviceHealth(cfg.sttUrl), serviceHealth(cfg.ttsUrl)]);
      return { chrome: chromeInstalled() ? ("ready" as const) : ("missing" as const), stt: stt?.ready ? ("ready" as const) : ("down" as const), tts: tts?.ready ? ("ready" as const) : ("down" as const) };
    });

  function events(s: SessionLike, req: Request): Response {
    const enc = new TextEncoder();
    let unsub: (() => void) | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(chunk));
          } catch {
            close();
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          unsub?.();
          if (ping) clearInterval(ping);
          try {
            controller.close();
          } catch {
            /* 이미 닫힘 */
          }
        };
        const snap = s.snapshot();
        send(sseEvent("state", { state: snap.state, ...(snap.reason ? { reason: snap.reason } : {}) }));
        // ?since=<마지막으로 받은 seq>: 끊겼다 다시 붙은 동안 놓친 transcript를 먼저 다시 보낸다
        const sinceRaw = new URL(req.url).searchParams.get("since");
        const since = sinceRaw ? Number(sinceRaw) : Number.NaN;
        if (Number.isFinite(since) && since >= 0 && s.transcriptsSince) for (const t of s.transcriptsSince(since)) send(sseEvent("transcript", t));
        if (!s.active) {
          send(sseEvent("ended", { reason: s.endReason ?? "error", ...(snap.state !== "ended" ? { state: snap.state } : {}) }));
          close();
          return;
        }
        unsub = s.subscribe((e) => {
          send(sseEvent(e.event, e.data));
          if (e.event === "ended") close();
        });
        ping = setInterval(() => send(SSE_PING), 15_000);
        req.signal.addEventListener("abort", close);
      },
      cancel() {
        closed = true;
        unsub?.();
        if (ping) clearInterval(ping);
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const m = /^\/sessions\/([A-Za-z0-9_-]+)(\/events|\/say|\/say\/stop|\/debug)?$/.exec(path);

    if (path === "/health" && req.method === "GET") {
      const h = await health();
      return json(200, { ok: true, ...h, sttEngine: cfg.stt, session: current?.active ? current.id : null });
    }

    if (path === "/sessions" && req.method === "POST") {
      const body = await readJson(req);
      if (!body) return err(400, "bad_json");
      let parsed = parseMeetUrl(body.url);
      let loopback = false;
      if (!parsed && cfg.testLoopback && body.test === "loopback" && typeof body.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/[\w./-]*$/.test(body.url)) {
        parsed = { code: "tst-loop-bck", url: body.url };
        loopback = true;
      }
      if (!parsed) return err(400, "invalid_url");
      if (current?.active) return err(409, "busy");
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : cfg.defaultName;
      const announce = typeof body.announce === "string" && body.announce.trim() ? body.announce.trim().slice(0, cfg.maxSayChars) : undefined;
      // sttPrompt: STT initial prompt(≤200자). 빈 문자열도 그대로 넘긴다(STT 기본 문장 끄기). 로그에 남기지 않는다
      const sttPrompt = typeof body.sttPrompt === "string" ? body.sttPrompt.trim().slice(0, 200) : undefined;
      const s = deps.makeSession({ id: newId(), url: parsed.url, code: parsed.code, name, announce, loopback, ...(sttPrompt !== undefined ? { sttPrompt } : {}) });
      current = s;
      remember(s);
      s.start();
      return json(201, { id: s.id, state: s.state });
    }

    if (m) {
      const s = sessions.get(m[1]!);
      if (!s) return err(404, "not_found");
      const sub = m[2];
      if (!sub && req.method === "GET") return json(200, s.snapshot());
      if (!sub && req.method === "DELETE") {
        const state = await s.leave();
        return json(200, { state });
      }
      if (sub === "/events" && req.method === "GET") return events(s, req);
      if (sub === "/say" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return err(400, "bad_json");
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return err(400, "empty_text");
        if (text.length > cfg.maxSayChars) return err(400, "too_long");
        if (s.state !== "in_call") return err(409, "not_in_call");
        if (body.cached === true) {
          // 맞장구: 미리 만들어 둔 소리를 TTS 없이 바로 낸다. 캐시에 없으면 일반 TTS로 말한다(계약 §2)
          const id = s.sayCached?.(text) ?? null;
          if (id) return json(202, { sayId: id, cached: true });
          return json(202, { sayId: s.sayText(text), cached: false });
        }
        return json(202, { sayId: s.sayText(text) });
      }
      if (sub === "/say/stop" && req.method === "POST") {
        const dropped = await s.stopSaying();
        return json(200, { ok: true, dropped });
      }
      if (sub === "/debug" && req.method === "GET" && cfg.testLoopback) return json(200, { stats: s.debugStats?.() ?? null, page: (await s.debugPage?.()) ?? null });
      return err(405, "method_not_allowed");
    }
    return err(404, "not_found");
  }

  return {
    fetch,
    sessions,
    get current() {
      return current;
    },
    async shutdown() {
      if (current?.active) await current.leave().catch(() => {});
    },
  };
}

if (import.meta.main) {
  const cfg = defaultConfig;
  const app = createApp(cfg, { makeSession: (init) => new Session(init, cfg) });
  const server = Bun.serve({ hostname: cfg.host, port: cfg.port, idleTimeout: 0, fetch: app.fetch });
  log(`listening on http://${cfg.host}:${server.port} (stt ${cfg.sttUrl}, tts ${cfg.ttsUrl}${cfg.testLoopback ? ", TEST LOOPBACK ON" : ""}${cfg.noJoin ? ", NO JOIN (dry run)" : ""})`);
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: leaving meeting and stopping`);
    await Promise.race([app.shutdown(), Bun.sleep(8000)]);
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}
