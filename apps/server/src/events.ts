/**
 * Server-Sent Events plumbing.
 * - SseChannel: one `text/event-stream` response; each event is `data: <json>\n\n`, comments
 *   (`: hb`) keep proxies and Bun's idle timer alive.
 * - EventHub: per-user fan-out of ServerEvents to every open /api/events stream (multiple tabs).
 */
import type { ServerEvent } from "@pickle/protocol";

const enc = new TextEncoder();

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export class SseChannel {
  readonly stream: ReadableStream<Uint8Array>;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closeHandlers: (() => void)[] = [];
  closed = false;

  constructor(heartbeatMs: number, signal?: AbortSignal) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.controller = c;
      },
      cancel: () => this.terminate(),
    });
    if (heartbeatMs > 0) this.timer = setInterval(() => this.comment("hb"), heartbeatMs);
    signal?.addEventListener("abort", () => this.terminate(), { once: true });
  }

  /** Called when the client goes away (or close() is called). */
  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeHandlers.push(fn);
  }

  send(obj: unknown): boolean {
    return this.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  comment(text: string): boolean {
    return this.write(`: ${text}\n\n`);
  }

  private write(chunk: string): boolean {
    if (this.closed || !this.controller) return false;
    try {
      this.controller.enqueue(enc.encode(chunk));
      return true;
    } catch {
      this.terminate();
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.controller?.close();
    } catch {
      /* already closed */
    }
    this.terminate();
  }

  private terminate(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const handlers = this.closeHandlers;
    this.closeHandlers = [];
    for (const h of handlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
  }

  response(status = 200, extra?: Record<string, string>): Response {
    return new Response(this.stream, { status, headers: { ...SSE_HEADERS, ...extra } });
  }
}

export class EventHub {
  private subs = new Map<string, Set<SseChannel>>();

  constructor(
    private heartbeatMs: number,
    private now: () => number,
  ) {}

  /**
   * Open a stream for `userId`. `revs` (the person's settings / agent revisions) is read AFTER the stream is registered,
   * then `hello` carries it: a change landing while it is read is still published to this stream as its event, where
   * reading first could put a stale rev in `hello` with the change's event already gone. Events published meanwhile go
   * out before `hello` (devices compare revs, not arrival order). A failed read sends `hello` without revs.
   */
  subscribe(userId: string, signal?: AbortSignal, revs?: () => Promise<{ settingsRev: number; agentRev: number }>): Response {
    const ch = new SseChannel(this.heartbeatMs, signal);
    let set = this.subs.get(userId);
    if (!set) this.subs.set(userId, (set = new Set()));
    set.add(ch);
    ch.onClose(() => {
      const s = this.subs.get(userId);
      s?.delete(ch);
      if (s && s.size === 0) this.subs.delete(userId);
    });
    ch.comment("connected");
    const at = this.now();
    if (!revs) ch.send({ type: "hello", at } satisfies ServerEvent);
    else
      void revs().then(
        (r) => ch.send({ type: "hello", at, settingsRev: r.settingsRev, agentRev: r.agentRev } satisfies ServerEvent),
        () => ch.send({ type: "hello", at } satisfies ServerEvent),
      );
    return ch.response();
  }

  publish(userId: string, ev: ServerEvent): void {
    const set = this.subs.get(userId);
    if (!set) return;
    for (const ch of set) ch.send(ev);
  }

  listeners(userId: string): number {
    return this.subs.get(userId)?.size ?? 0;
  }

  closeAll(): void {
    for (const set of this.subs.values()) for (const ch of set) ch.close();
    this.subs.clear();
  }
}
