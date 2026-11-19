/**
 * Discord user-account login through Discord's own "log in with QR code" (remote auth), using agent-messenger's
 * `loginWithRemoteAuth`. No password and no token ever pass through the person's hands:
 *   waiting_scan    the server holds a remote-auth socket; the app shows https://discord.com/ra/<fingerprint> as a
 *                   button that opens the Discord app on the same phone, and as a QR for another device
 *   waiting_confirm the Discord app scanned it; Discord sent who it is (name only) and waits for "로그인" there
 *   done            Discord released a ticket; it was exchanged for the token, which goes to the hub (vault)
 * plus expired (the gateway's own ~4 min limit), cancelled (here or in the Discord app) and error.
 *
 * The RSA key pair is created inside `loginWithRemoteAuth` for this one attempt and lives only in its closure.
 * Nothing here logs; upstream error text is mapped to fixed Korean sentences.
 */
import type { LoginResult, LoginView } from "./types";
import { clip } from "../util";

export interface RemoteAuthUserLike {
  id: string;
  username: string;
  discriminator?: string;
  avatar?: string | null;
}

/** the parts of agent-messenger's remote-auth socket the SDK uses (a `ws` WebSocket) */
export interface RemoteAuthSocket {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, fn: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(): void;
}

export interface RemoteAuthOptionsLike {
  onQrUrl?: (url: string) => void | Promise<void>;
  onPendingLogin?: (user: RemoteAuthUserLike) => void;
  timeoutMs?: number;
  createWebSocket?: (url: string) => never;
  fetchImpl?: typeof fetch;
}

export type LoginWithRemoteAuth = (o: RemoteAuthOptionsLike) => Promise<{ token: string; user: RemoteAuthUserLike | null }>;

const QR_PREFIX = "https://discord.com/ra/";
const ORIGIN = "https://discord.com";

export interface DiscordRemoteAuthOptions {
  /** agent-messenger's loginWithRemoteAuth (tests pass a fake that drives a fake gateway) */
  login: LoginWithRemoteAuth;
  /** opens the gateway socket; default: Bun's WebSocket with the discord.com Origin header */
  socket?: (url: string) => RemoteAuthSocket;
  /** how long to wait for the scan + approval; the gateway closes earlier on its own (~4 min) */
  timeoutMs: number;
  /** fires on every state change (the relay keeps its view in sync; the app polls) */
  onChange?: (v: LoginView) => void;
  /** test seam for the ticket → token exchange (default: global fetch) */
  fetchImpl?: typeof fetch;
}

/** Bun's WebSocket (it accepts headers) behind the EventEmitter-style API the SDK calls (`on`, `send`, `close`). */
export function bunSocket(url: string): RemoteAuthSocket {
  const Ctor = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket;
  const ws = new Ctor(url, { headers: { Origin: ORIGIN } });
  ws.binaryType = "arraybuffer";
  return {
    on(event, fn) {
      const f = fn as (...a: unknown[]) => void;
      if (event === "open") ws.addEventListener("open", () => f());
      else if (event === "message")
        ws.addEventListener("message", (e) => f(Buffer.from(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer))));
      else if (event === "close") ws.addEventListener("close", (e) => f(e.code));
      else if (event === "error") ws.addEventListener("error", () => f(new Error("socket error")));
      return this;
    },
    send: (data) => ws.send(data),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function errorView(e: unknown): LoginView {
  const code = String((e as { code?: unknown } | null)?.code ?? "");
  switch (code) {
    case "remote_auth_timeout":
      return { state: "expired", error: { code: "timeout", message: "QR 코드 유효 시간이 지났어요. 새 코드를 만들어 주세요." } };
    case "remote_auth_cancelled":
      return { state: "cancelled", error: { code: "qr_rejected", message: "디스코드 앱에서 로그인을 취소했어요." } };
    case "remote_auth_captcha":
      return {
        state: "error",
        error: { code: "captcha", message: "디스코드가 추가 보안 확인(캡차)을 요구해 로그인을 끝내지 못했어요. 잠시 후 다시 시도해 주세요." },
      };
    case "remote_auth_login_failed":
      return { state: "error", error: { code: "upstream", message: "디스코드가 로그인을 마무리하지 못했어요. 다시 시도해 주세요." } };
    default:
      return { state: "error", error: { code: "network", message: "디스코드에 연결하지 못했어요. 잠시 후 다시 시도해 주세요." } };
  }
}

/**
 * One remote-auth attempt. `start()` resolves once the QR link is ready (or the attempt failed before that);
 * completion arrives through `onChange` and `result()`.
 */
export class DiscordRemoteAuth {
  private view: LoginView = { state: "waiting_scan" };
  private sock: RemoteAuthSocket | null = null;
  private outcome: LoginResult | null = null;
  private cancelled = false;
  private settled = false;
  private done: Promise<void> | null = null;
  private helloTimeoutMs: number | null = null;

  constructor(private readonly o: DiscordRemoteAuthOptions) {}

  /** how long Discord keeps this QR alive (the gateway's `hello.timeout_ms`, ~4 min), once the gateway said hello */
  get gatewayTimeoutMs(): number | null {
    return this.helloTimeoutMs;
  }

  get current(): LoginView {
    return { ...this.view, ...(this.view.account ? { account: { ...this.view.account } } : {}) };
  }

  start(): Promise<LoginView> {
    let ready!: () => void;
    const qrReady = new Promise<void>((r) => (ready = r));
    const login = this.o.login({
      timeoutMs: this.o.timeoutMs,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
      createWebSocket: ((url: string) => {
        const sock = (this.o.socket ?? bunSocket)(url);
        this.sock = sock;
        // read Discord's own QR lifetime from the greeting (only that field; nothing else is kept)
        sock.on("message", (data: unknown) => {
          if (this.helloTimeoutMs !== null) return;
          try {
            const m = JSON.parse(String(data)) as { op?: unknown; timeout_ms?: unknown };
            if (m?.op === "hello" && typeof m.timeout_ms === "number" && m.timeout_ms > 10_000 && m.timeout_ms < 3_600_000) this.helloTimeoutMs = m.timeout_ms;
          } catch {
            /* not JSON: the SDK reports it */
          }
        });
        return sock as never;
      }) as (url: string) => never,
      onQrUrl: (url) => {
        if (typeof url !== "string" || !url.startsWith(QR_PREFIX) || url.length > 200) throw new Error("unexpected qr url");
        this.set({ state: "waiting_scan", qrUrl: url });
        ready();
      },
      onPendingLogin: (user) => {
        const name = clip(String(user?.username ?? "").trim(), 40);
        this.set({ state: "waiting_confirm", account: { name: name || "디스코드 사용자" } });
      },
    });
    this.done = login.then(
      ({ token, user }) => {
        this.settled = true;
        this.sock = null;
        if (this.cancelled) return;
        if (typeof token !== "string" || token.length < 20) {
          this.set({ state: "error", error: { code: "upstream", message: "디스코드가 로그인을 마무리하지 못했어요. 다시 시도해 주세요." } });
          return;
        }
        const label = user?.username ? clip(user.username, 80) : null;
        this.outcome = { secret: { token }, accountLabel: label, meta: user?.id ? { discordUserId: user.id } : {} };
        this.set({ state: "done" });
      },
      (e) => {
        this.settled = true;
        this.sock = null;
        if (this.cancelled) return;
        this.set(errorView(e));
      },
    );
    this.done.finally(ready);
    return qrReady.then(() => this.current);
  }

  /** The session secret, once, after `done`. */
  result(): LoginResult | null {
    const r = this.outcome;
    this.outcome = null;
    return r;
  }

  /** Closes the socket (the SDK then settles) and drops anything it produced. */
  async cancel(): Promise<LoginView> {
    if (this.view.state === "done" || this.settled) {
      this.outcome = null;
      return this.current;
    }
    this.cancelled = true;
    this.set({ state: "cancelled", error: { code: "cancelled", message: "로그인을 취소했어요." } });
    try {
      this.sock?.close();
    } catch {
      /* already closed */
    }
    this.sock = null;
    await this.done?.catch(() => {});
    this.outcome = null;
    return this.current;
  }

  /** resolves when the SDK call has settled (tests, cleanup) */
  async settledPromise(): Promise<void> {
    await this.done?.catch(() => {});
  }

  private set(v: LoginView): void {
    this.view = v;
    try {
      this.o.onChange?.(this.current);
    } catch {
      /* listener errors must not break the flow */
    }
  }
}
