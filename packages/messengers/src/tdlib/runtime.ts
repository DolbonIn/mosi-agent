/**
 * A small TDLib (tdjson) runtime for a multi-user server.
 *
 * agent-messenger's Telegram client is not usable here: its package does not export `./telegram`, it calls the
 * blocking `td_receive` on the event loop (up to 0.5 s per call), and it ignores `@client_id`, so two users' clients in
 * one process would read each other's updates. This runtime instead
 *   - loads the prebuilt libtdjson that agent-messenger already installs (koffi + prebuilt-tdlib, resolved from
 *     agent-messenger's own dependency tree, nothing installed), or TDLIB_PATH;
 *   - runs ONE receive loop per process with koffi's async call (a worker thread does the blocking wait);
 *   - routes every event by `@client_id`, and every answer by a per-request `@extra`.
 *
 * Nothing here logs. TDLib's own log is switched off (verbosity 0) because it can contain phone numbers.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export interface TdJson {
  createClientId(): number;
  send(clientId: number, request: string): void;
  /** waits up to `timeoutSec` on a worker thread; null when nothing arrived */
  receive(timeoutSec: number): Promise<string | null>;
  execute(request: string): string | null;
}

/** a TDLib object */
export type TdObject = { "@type": string; [k: string]: unknown };

export class TdError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "TdError";
    this.code = code;
  }
}

const AGENT_MESSENGER_PKG = "agent-messenger/package.json";

/**
 * Availability without loading anything native (provider probes at boot): koffi resolvable and a libtdjson file
 * present (explicit path → TDLIB_PATH → prebuilt-tdlib's path lookup, which is plain JS). The library itself is loaded
 * only when the first Telegram login or session needs it.
 */
export function tdjsonAvailable(explicitPath?: string): boolean {
  try {
    const req = createRequire(import.meta.resolve(AGENT_MESSENGER_PKG));
    req.resolve("koffi");
    const path = explicitPath || process.env.TDLIB_PATH || (req("prebuilt-tdlib") as { getTdjson(): string }).getTdjson();
    return !!path && existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Loads libtdjson. Order: explicit path → TDLIB_PATH → prebuilt-tdlib (agent-messenger's optional dependency).
 * Throws when koffi or the library is missing (the provider then shows "준비 중").
 */
export async function loadTdJson(explicitPath?: string): Promise<TdJson> {
  const amPkg = import.meta.resolve(AGENT_MESSENGER_PKG);
  const req = createRequire(amPkg);
  const koffi = req("koffi") as {
    load(path: string): { func(sig: string): ((...a: unknown[]) => unknown) & { async: (...a: unknown[]) => void } };
  };
  let path = explicitPath || process.env.TDLIB_PATH || "";
  if (!path) {
    const pre = req("prebuilt-tdlib") as { getTdjson(): string };
    path = pre.getTdjson();
  }
  const lib = koffi.load(path);
  const create = lib.func("int td_create_client_id(void)");
  const send = lib.func("void td_send(int client_id, const char* request)");
  const receive = lib.func("const char* td_receive(double timeout)");
  const execute = lib.func("const char* td_execute(const char* request)");
  const td: TdJson = {
    createClientId: () => create() as number,
    send: (id, request) => {
      send(id, request);
    },
    receive: (timeoutSec) =>
      new Promise((resolve, reject) => {
        receive.async(timeoutSec, (err: unknown, value: string | null) => (err ? reject(err) : resolve(value ?? null)));
      }),
    execute: (request) => (execute(request) as string | null) ?? null,
  };
  td.execute(JSON.stringify({ "@type": "setLogVerbosityLevel", new_verbosity_level: 0 }));
  return td;
}

type Listener = (update: TdObject) => void;

interface Waiter {
  resolve: (v: TdObject) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One TDLib instance (one account). Create through `TdRuntime.client()`. */
export class TdClient {
  readonly id: number;
  private readonly waiters = new Map<string, Waiter>();
  private readonly listeners = new Set<Listener>();
  private seq = 0;
  private closedFlag = false;
  authState: TdObject | null = null;

  constructor(
    private readonly runtime: TdRuntime,
    id: number,
  ) {
    this.id = id;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** Sends a request and resolves with TDLib's answer; rejects with TdError on `error`. */
  request<T extends TdObject = TdObject>(query: TdObject, timeoutMs = 20_000): Promise<T> {
    if (this.closedFlag) return Promise.reject(new TdError(500, "client closed"));
    const extra = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(extra);
        reject(new TdError(408, "timeout"));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.waiters.set(extra, { resolve: resolve as (v: TdObject) => void, reject, timer });
      this.runtime.send(this.id, { ...query, "@extra": extra });
    });
  }

  /** Every update (no `@extra`) for this client. Returns an unsubscribe function. */
  onUpdate(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Resolves with the first authorization state for which `pick` returns true (the current one included).
   * Rejects after `timeoutMs`, or when the client closes first.
   */
  waitAuth(pick: (state: TdObject) => boolean, timeoutMs = 20_000): Promise<TdObject> {
    if (this.authState && pick(this.authState)) return Promise.resolve(this.authState);
    return new Promise<TdObject>((resolve, reject) => {
      const off = this.onUpdate((u) => {
        if (u["@type"] !== "updateAuthorizationState") return;
        const s = u.authorization_state as TdObject;
        if (pick(s)) {
          done();
          resolve(s);
        } else if (s["@type"] === "authorizationStateClosed") {
          done();
          reject(new TdError(500, "client closed"));
        }
      });
      const timer = setTimeout(() => {
        done();
        reject(new TdError(408, "timeout"));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const done = () => {
        off();
        clearTimeout(timer);
      };
    });
  }

  /** Asks TDLib to close and waits (bounded) for `authorizationStateClosed`. Idempotent. */
  async close(timeoutMs = 5_000): Promise<void> {
    if (this.closedFlag) return;
    const closed = this.authState?.["@type"] === "authorizationStateClosed" ? Promise.resolve() : this.waitAuth((s) => s["@type"] === "authorizationStateClosed", timeoutMs).then(
      () => undefined,
      () => undefined,
    );
    try {
      this.runtime.send(this.id, { "@type": "close" });
    } catch {
      /* already gone */
    }
    await closed;
    this.finish();
  }

  /** @internal called by the runtime */
  dispatch(ev: TdObject): void {
    const extra = typeof ev["@extra"] === "string" ? (ev["@extra"] as string) : null;
    if (extra) {
      const w = this.waiters.get(extra);
      if (w) {
        this.waiters.delete(extra);
        clearTimeout(w.timer);
        if (ev["@type"] === "error") w.reject(new TdError(Number(ev.code) || 400, String(ev.message ?? "error")));
        else w.resolve(ev);
      }
      return;
    }
    if (ev["@type"] === "updateAuthorizationState") this.authState = ev.authorization_state as TdObject;
    for (const fn of [...this.listeners]) {
      try {
        fn(ev);
      } catch {
        /* a listener must not break dispatch */
      }
    }
    if (this.authState?.["@type"] === "authorizationStateClosed") this.finish();
  }

  private finish(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const [k, w] of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new TdError(500, "client closed"));
      this.waiters.delete(k);
    }
    this.listeners.clear();
    this.runtime.release(this);
  }
}

/** Process-wide owner of the receive loop. The loop runs only while at least one client is open. */
export class TdRuntime {
  private readonly clients = new Map<number, TdClient>();
  private looping = false;

  constructor(private readonly td: TdJson) {}

  client(): TdClient {
    const c = new TdClient(this, this.td.createClientId());
    this.clients.set(c.id, c);
    // the first request makes TDLib start the instance; ask for the state so `authState` is filled
    void c.request({ "@type": "getAuthorizationState" }).then(
      (s) => {
        if (!c.authState) c.authState = s;
      },
      () => {},
    );
    this.loop();
    return c;
  }

  /** open clients (tests, diagnostics) */
  get size(): number {
    return this.clients.size;
  }

  /** @internal */
  send(clientId: number, query: TdObject): void {
    this.td.send(clientId, JSON.stringify(query));
  }

  /** @internal */
  release(c: TdClient): void {
    this.clients.delete(c.id);
  }

  private loop(): void {
    if (this.looping) return;
    this.looping = true;
    void (async () => {
      try {
        while (this.clients.size > 0) {
          let raw: string | null = null;
          try {
            raw = await this.td.receive(1.0);
          } catch {
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          if (!raw) continue;
          let ev: TdObject;
          try {
            ev = JSON.parse(raw) as TdObject;
          } catch {
            continue;
          }
          const cid = Number(ev["@client_id"]);
          this.clients.get(cid)?.dispatch(ev);
        }
      } finally {
        this.looping = false;
        if (this.clients.size > 0) this.loop();
      }
    })();
  }
}

let shared: Promise<TdRuntime> | null = null;

/** The process-wide runtime (lazy). A failed load is retried on the next call. */
export function sharedTdRuntime(): Promise<TdRuntime> {
  shared ??= loadTdJson().then((td) => new TdRuntime(td));
  shared.catch(() => {
    shared = null;
  });
  return shared;
}
