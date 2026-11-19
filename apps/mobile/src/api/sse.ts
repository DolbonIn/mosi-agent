import type { AgentEvent, Message, SteeredResponse } from "@pickle/protocol";
import { ApiError, apiRaw, koreanMessage, toApiError } from "./client";

/**
 * Turn streams are POSTs read with fetch streaming (EventSource can't POST or send headers), SERVER-CONTRACT §SSE:
 * one `data: <AgentEvent JSON>` per event, blank-line separated; `: hb` comment lines are heartbeats (ignored).
 * Order: start → status/text/tool/card/memory … → done | error, then the stream closes. HTTP is 200 even when the
 * turn fails (the `error` event says so); errors before streaming are JSON `{error, message}` → ApiError.
 * Non-stream answers of POST /api/threads/:id/messages:
 *   202 SteeredResponse {steered:true, userMessage} — busy in the SAME thread: the text joined the running turn
 *   201 {delivered:true, userMessage}              — friend thread, not addressed to the agent: no turn
 */

/** 201 answer for a friend-thread message that was not addressed to the agent */
export interface DeliveredResponse {
  delivered: true;
  userMessage: Message;
}

export type DoneEvent = Extract<AgentEvent, { type: "done" }>;
export type ErrorEvent = Extract<AgentEvent, { type: "error" }>;

export type TurnResult =
  | { kind: "stream"; done: DoneEvent | null; error: ErrorEvent | null }
  | { kind: "steered"; response: SteeredResponse }
  | { kind: "delivered"; response: DeliveredResponse };

export interface SseParser {
  push(chunk: string): void;
  /** flush a trailing line / pending event at end of stream */
  end(): void;
}

/**
 * Pure SSE line parser (WHATWG event-stream): `\n`, `\r\n` and `\r` line ends (also split across chunks), multi-line
 * `data:` joined with "\n", `data:` with or without the space, `:` comments, `event:` names, dispatch on a blank line.
 */
export function createSseParser(onData: (data: string, event: string) => void): SseParser {
  let buf = "";
  let data: string[] = [];
  let event = "";

  const dispatch = () => {
    if (data.length) onData(data.join("\n"), event || "message");
    data = [];
    event = "";
  };

  const line = (l: string) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return; // comment / keep-alive
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    // id / retry: not used
  };

  return {
    push(chunk: string) {
      buf += chunk;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c === 10 /* \n */) {
          line(buf.slice(start, i));
          start = i + 1;
        } else if (c === 13 /* \r */) {
          if (i === buf.length - 1) break; // may be the first half of \r\n: wait for the next chunk
          line(buf.slice(start, i));
          if (buf.charCodeAt(i + 1) === 10) i++;
          start = i + 1;
        }
      }
      buf = buf.slice(start);
    },
    end() {
      if (buf) {
        line(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
        buf = "";
      }
      dispatch();
    },
  };
}

function toAgentEvent(data: string, event: string): AgentEvent | null {
  if (data === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    if (event === "error") return { type: "error", error: "stream_error", message: data || koreanMessage(500) };
    return null; // ignore unparsable lines
  }
  if (event === "error") {
    const p = (parsed ?? {}) as { error?: unknown; message?: unknown };
    return {
      type: "error",
      error: typeof p.error === "string" ? p.error : "stream_error",
      message: typeof p.message === "string" ? p.message : koreanMessage(500),
    };
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") return null;
  return parsed as AgentEvent;
}

export interface StreamOptions {
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** the server accepted the request (headers arrived OK) — before any event; `kind` says what follows */
  onAccepted?: (kind: TurnResult["kind"]) => void;
}

/**
 * Start a turn. Resolves when the stream ends (done/error captured) or immediately with the steered response.
 * Non-OK → ApiError (Korean). Abort → ApiError code "aborted".
 */
export async function streamTurn(path: string, body: unknown, { onEvent, signal, onAccepted }: StreamOptions): Promise<TurnResult> {
  const res = await apiRaw("POST", path, body, {
    signal,
    timeoutMs: 30_000, // until headers arrive; the stream itself may run long
    headers: { Accept: "text/event-stream, application/json" },
  });
  const type = res.headers.get("content-type") ?? "";
  if (res.status === 201 || res.status === 202 || type.includes("application/json")) {
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(res.status, "bad_response", koreanMessage(0, "bad_response"));
    }
    const j = (json ?? {}) as { steered?: unknown; delivered?: unknown; userMessage?: unknown };
    if (j.steered === true && j.userMessage) {
      onAccepted?.("steered");
      return { kind: "steered", response: json as SteeredResponse };
    }
    if (j.delivered === true && j.userMessage) {
      onAccepted?.("delivered");
      return { kind: "delivered", response: json as DeliveredResponse };
    }
    throw new ApiError(res.status, "bad_response", koreanMessage(0, "bad_response"));
  }
  onAccepted?.("stream");

  let done: DoneEvent | null = null;
  let error: ErrorEvent | null = null;
  const parser = createSseParser((data, event) => {
    const e = toAgentEvent(data, event);
    if (!e) return;
    if (e.type === "done") done = e;
    else if (e.type === "error") error = e;
    onEvent(e);
  });

  try {
    if (!res.body) {
      parser.push(await res.text());
      parser.end();
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const onAbort = () => {
        reader.cancel().catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          if (value) parser.push(decoder.decode(value, { stream: true }));
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        }
        // Stop: onAbort cancels the reader, which makes read() resolve { done: true } — an abort, not a clean end
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        parser.push(decoder.decode());
        parser.end();
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
  } catch (e) {
    if (signal?.aborted) throw new ApiError(0, "aborted", koreanMessage(0, "aborted"));
    throw toApiError(e);
  }
  return { kind: "stream", done, error };
}
