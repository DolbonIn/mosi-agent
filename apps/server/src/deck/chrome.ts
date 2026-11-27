/**
 * An already-installed Chrome, driven over the DevTools protocol with Bun's own WebSocket: no package, no download,
 * nothing installed (lead 0052). Each run gets a fresh temporary profile, runs headless, refuses every request that is
 * not file: or data:, and ends by closing the browser it started and only that one (lead 1438).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** where Chrome lives on a Mac; PICKLE_DECK_CHROME names another (the caller passes it in) */
export const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** how every run starts Chrome: headless, a fresh profile (added per run), and nothing that answers a request */
export const CHROME_FLAGS: readonly string[] = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
  "--metrics-recording-only",
  "--mute-audio",
  "--hide-scrollbars",
  "--password-store=basic",
  "--use-mock-keychain",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  // no name resolves and no proxy answers: nothing leaves the machine even if a page asked
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--proxy-server=127.0.0.1:9",
  "--remote-debugging-port=0",
];

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** one DevTools connection: commands by id, events by name (and session) */
export class Cdp {
  private id = 0;
  private pending = new Map<number, Pending>();
  private waiters: { method: string; session?: string; resolve: (p: unknown) => void }[] = [];
  private handlers: { method: string; fn: (p: Record<string, unknown>, session?: string) => void }[] = [];
  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (m.id != null) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
        return;
      }
      if (!m.method) return;
      for (const h of this.handlers) if (h.method === m.method) h.fn(m.params ?? {}, m.sessionId);
      const i = this.waiters.findIndex((w) => w.method === m.method && (w.session == null || w.session === m.sessionId));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m.params);
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("DevTools connection closed"));
      this.pending.clear();
    };
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error("DevTools connection failed"));
    });
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  /** the next event of that name (registered before the command that causes it) */
  next<T = Record<string, unknown>>(method: string, session?: string): Promise<T> {
    return new Promise<T>((resolve) => this.waiters.push({ method, session, resolve: resolve as (p: unknown) => void }));
  }
  on(method: string, fn: (p: Record<string, unknown>, session?: string) => void) {
    this.handlers.push({ method, fn });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** a page in the browser: one attached target */
export interface Page {
  cdp: Cdp;
  session: string;
  /** a working folder inside the run's temporary directory, removed with it */
  dir: string;
  /** the browser process this run started (the only one it ends) */
  pid: number;
  /** evaluate an expression in the page and return its value (JSON) */
  evaluate<T>(expression: string): Promise<T>;
  /** open a file: URL and wait for its load event */
  goto(url: string): Promise<void>;
  viewport(width: number, height: number): Promise<void>;
}

export class ChromeMissing extends Error {}

/**
 * Start Chrome, run `fn` with one page, and close it. `timeoutMs` bounds the whole run: past it the browser is killed
 * (by the pid this call started) and the call fails.
 */
export async function withChrome<T>(chromePath: string, fn: (page: Page) => Promise<T>, timeoutMs = 90_000): Promise<T> {
  if (!(await Bun.file(chromePath).exists())) throw new ChromeMissing(chromePath);
  const tmp = await mkdtemp(join(tmpdir(), "pickle-deck-"));
  const proc = Bun.spawn([chromePath, ...CHROME_FLAGS, `--user-data-dir=${join(tmp, "profile")}`, "about:blank"], { stdout: "ignore", stderr: "pipe" });
  let cdp: Cdp | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = (async () => {
      const wsUrl = await devtoolsUrl(proc.stderr);
      cdp = await Cdp.open(wsUrl);
      const c = cdp;
      const { targetId } = await c.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await c.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      // only file: and data: load; anything else is failed before it leaves
      c.on("Fetch.requestPaused", (p, s) => void c.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, s).catch(() => {}));
      await c.send("Fetch.enable", { patterns: [{ urlPattern: "http*" }, { urlPattern: "ws*" }, { urlPattern: "ftp*" }] }, sessionId);
      await c.send("Page.enable", {}, sessionId);
      await c.send("Runtime.enable", {}, sessionId);
      const dir = join(tmp, "work");
      await Bun.write(join(dir, ".keep"), "");
      const page: Page = {
        cdp: c,
        session: sessionId,
        dir,
        pid: proc.pid,
        async evaluate<V>(expression: string) {
          const r = await c.send<{ result: { value?: V }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
            "Runtime.evaluate",
            { expression, awaitPromise: true, returnByValue: true },
            sessionId,
          );
          if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
          return r.result.value as V;
        },
        async goto(url: string) {
          const loaded = c.next("Page.loadEventFired", sessionId);
          await c.send("Page.navigate", { url }, sessionId);
          await loaded;
        },
        async viewport(width: number, height: number) {
          await c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        },
      };
      return fn(page);
    })();
    const out = await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Chrome did not finish in ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return out;
  } finally {
    clearTimeout(timer);
    const c = cdp as Cdp | null;
    if (c) {
      await c.send("Browser.close").catch(() => {});
      c.close();
    }
    // the browser this call started, and only it
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Chrome prints its DevTools address on stderr: "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/…" */
async function devtoolsUrl(stderr: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stderr.getReader();
  const dec = new TextDecoder();
  let seen = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Chrome exited before DevTools was ready: ${seen.slice(-300)}`);
    seen += dec.decode(value, { stream: true });
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
    if (m) {
      // keep draining so Chrome never blocks on a full pipe
      void (async () => {
        for (;;) if ((await reader.read()).done) break;
      })().catch(() => {});
      return m[1]!;
    }
  }
}
