import type { Connection, KeepFor, LoginRelayResponse, LoginRelayState } from "@pickle/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAborted, toApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { onServerEvent } from "../../../api/events";

/**
 * The login relay state machine the Discord and Telegram sheets share (POST /api/connections/:provider/login → /step
 * → /cancel, SERVER-CONTRACT "로그인 릴레이"). It owns:
 *   - the relay id (one at a time), cancelled when the sheet closes or the component unmounts
 *   - `busy`: the words the primary button shows while a request is in flight (one request at a time)
 *   - sealing: every typed value is sealed ON THIS DEVICE for the enclave, bound to this relay
 *     (aad `${userId}:${provider}:login-relay:${relayId}`), before it leaves
 *   - waiting on another device (Discord app): polls every `pollMs`, at once when the page becomes visible again
 *     (back from the Discord app) and when the server pushes the provider's `connection` event
 *   - terminal answers (expired / cancelled / error) end the relay and are kept in `ended`
 */

export type RelayField = "phone" | "code" | "password";

export interface LoginRelay {
  /** the latest live answer (null before start and after an end) */
  live: LoginRelayResponse | null;
  /** the terminal answer that ended the last relay (expired / cancelled / error) */
  ended: LoginRelayResponse | null;
  /** words for the primary button while a request runs */
  busy: string | null;
  /** a retryable mistake (wrong code, bad number) or a request failure; cleared by the next request */
  error: { code?: string; message: string } | null;
  start(label: string, then?: (res: LoginRelayResponse) => Promise<LoginRelayResponse | null>): Promise<void>;
  submit(field: RelayField, value: string, label: string): Promise<void>;
  /** cancel the relay on the server and forget it (back to the first screen) */
  reset(): void;
  clearError(): void;
  /** seal a value for the current (or a just-started) relay */
  seal(relayId: string, field: RelayField, value: string): ReturnType<typeof ep.sealRelayInput>;
}

const TERMINAL: ReadonlySet<LoginRelayState> = new Set(["expired", "cancelled", "error"]);
const WAITING: ReadonlySet<LoginRelayState> = new Set(["waiting_scan", "waiting_confirm"]);

export function useLoginRelay({
  provider,
  userId,
  enabled,
  keepFor = "30d",
  onConnected,
}: {
  provider: string;
  userId: string | null;
  /** false: the hook stays idle (the sheet is for another provider) */
  enabled: boolean;
  keepFor?: KeepFor;
  onConnected: (c: Connection) => void;
}): LoginRelay {
  const [live, setLive] = useState<LoginRelayResponse | null>(null);
  const [ended, setEnded] = useState<LoginRelayResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<LoginRelay["error"]>(null);
  const liveRef = useRef<LoginRelayResponse | null>(null);
  liveRef.current = live;
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // the sheet closed mid-login: close the server side now instead of waiting for the 5-minute timeout
      const r = liveRef.current;
      if (r && !TERMINAL.has(r.state) && r.state !== "connected") void ep.loginRelayCancel(provider, r.relayId).catch(() => {});
    };
  }, [provider]);

  const apply = useCallback((res: LoginRelayResponse) => {
    if (!mounted.current) return;
    if (res.state === "connected") {
      liveRef.current = null;
      setLive(null);
      setEnded(null);
      setError(null);
      if (res.connection) connectedRef.current(res.connection);
      return;
    }
    if (TERMINAL.has(res.state)) {
      liveRef.current = null;
      setLive(null);
      setEnded(res);
      setError(null);
      return;
    }
    liveRef.current = res;
    setLive(res);
    setEnded(null);
    // a wrong code / bad number comes back on the same step with a message
    setError(res.error ? { code: res.error.code, message: res.error.message } : null);
  }, []);

  const run = useCallback(
    async (label: string, work: () => Promise<LoginRelayResponse | null>) => {
      if (busyRef.current || !userId || !enabled) return;
      busyRef.current = true;
      setBusy(label);
      setError(null);
      try {
        const res = await work();
        if (res) apply(res);
      } catch (e) {
        if (!mounted.current || isAborted(e)) return;
        const err = toApiError(e);
        if (err.code === "relay_not_found") {
          liveRef.current = null;
          setLive(null);
        }
        setError({ code: err.code, message: err.message });
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [apply, userId, enabled],
  );

  const seal = useCallback(
    (relayId: string, field: RelayField, value: string) => ep.sealRelayInput(userId ?? "", provider, relayId, { [field]: value }),
    [provider, userId],
  );

  const start = useCallback(
    (label: string, then?: (res: LoginRelayResponse) => Promise<LoginRelayResponse | null>) =>
      run(label, async () => {
        setEnded(null);
        const res = await ep.loginRelayStart(provider, { provider: provider as "discord" | "telegram", keepFor });
        if (then && !TERMINAL.has(res.state) && res.state !== "connected") {
          // show the intermediate state first, so a failure in `then` leaves the person on the right screen
          apply(res);
          return (await then(res)) ?? res;
        }
        return res;
      }),
    [run, provider, keepFor, apply],
  );

  const submit = useCallback(
    (field: RelayField, value: string, label: string) => {
      const r = liveRef.current;
      if (!r) return Promise.resolve();
      return run(label, async () => ep.loginRelayStep(provider, { relayId: r.relayId, [field]: await seal(r.relayId, field, value) }));
    },
    [run, provider, seal],
  );

  const reset = useCallback(() => {
    const r = liveRef.current;
    if (r) void ep.loginRelayCancel(provider, r.relayId).catch(() => {});
    liveRef.current = null;
    setLive(null);
    setEnded(null);
    setError(null);
  }, [provider]);

  // waiting on another device: poll; at once on return to the page and on the provider's connection event
  const waiting = !!live && WAITING.has(live.state);
  const pollMs = Math.max(1000, live?.pollMs ?? 2000);
  const relayId = live?.relayId ?? null;
  useEffect(() => {
    if (!enabled || !waiting || !relayId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    const tick = async () => {
      if (stop || inflight) return;
      inflight = true;
      try {
        const res = await ep.loginRelayStep(provider, { relayId }, { timeoutMs: 15_000 });
        if (!stop) apply(res);
      } catch (e) {
        if (stop || isAborted(e)) return;
        const err = toApiError(e);
        if (err.status === 404) {
          liveRef.current = null;
          setLive(null);
          setError({ code: err.code, message: err.message });
          stop = true;
          return;
        }
      } finally {
        inflight = false;
      }
      if (!stop && liveRef.current && WAITING.has(liveRef.current.state)) {
        clearTimeout(timer);
        timer = setTimeout(tick, pollMs);
      }
    };
    timer = setTimeout(tick, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const off = onServerEvent((e) => {
      if (e.type === "connection" && e.connection.provider === provider && e.connection.status === "connected") {
        clearTimeout(timer);
        void tick();
      }
    });
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      off();
    };
  }, [enabled, waiting, relayId, pollMs, provider, apply]);

  return { live, ended, busy, error, start, submit, reset, clearError: () => setError(null), seal };
}

/** "4:05" / "0:42" from milliseconds left */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
