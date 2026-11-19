import { turnIncomplete } from "@pickle/protocol";

/**
 * The call's unfinished-line hold (the meeting's turn hold, MEET-CONTRACT §3, in the app): a final transcript that
 * looks unfinished ("내일 회의 자료를", "확인하고", "그리고" — turnIncomplete, shared with meet.ts) waits up to
 * `holdMs` for the rest before it is sent. Speech meanwhile (an interim result) starts the wait over; the next final
 * joins it and the whole line is judged again: finished → sent at once, still unfinished → held again. However it is
 * kept waiting, a line goes at most `maxMs` after it was first held (the meeting's turnMaxMs: speech-like noise, or a
 * question whose "?" the recogniser dropped, can't hold it for ever). A line that looks finished is sent at once (no
 * delay). Pure (timers and clock injected), unit-tested in qa/call-hold.test.ts.
 */
export const CALL_HOLD_MS = 1500;
/** the most a line waits, counted from when it was first held (as the meeting's turnMaxMs) */
export const CALL_HOLD_MAX_MS = 10_000;

/** VITE_CALL_HOLD_MS (build env) → the hold; unset, invalid or out of range → CALL_HOLD_MS (0 turns the hold off) */
export function holdMsFrom(raw: unknown): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") return CALL_HOLD_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? Math.round(n) : CALL_HOLD_MS;
}

export interface LineHold {
  /** a final transcript: sent now if it (joined to what waits) looks finished, held otherwise */
  final(text: string): void;
  /** the person is still talking: the wait starts over (no-op when nothing waits) */
  interim(): void;
  /** send what waits now, with `extra` joined to it (typed text, mute); nothing waits and no extra → nothing sent */
  flush(extra?: string): void;
  /** forget what waits (the call ended) */
  drop(): void;
  /** the text waiting ("" when nothing waits) */
  held(): string;
}

export function lineHold(o: {
  holdMs: number;
  /** the cap from when the line was first held (default CALL_HOLD_MAX_MS) */
  maxMs?: number;
  send(text: string): void;
  /** the line changed hands: held, or no longer held (sent / dropped) */
  onChange?(held: string): void;
  incomplete?: (text: string) => boolean;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}): LineHold {
  const incomplete = o.incomplete ?? turnIncomplete;
  const maxMs = o.maxMs ?? CALL_HOLD_MAX_MS;
  const now = o.now ?? (() => performance.now());
  const setTimer = o.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms));
  const clearTimer = o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let held = "";
  /** when the line now waiting was first held */
  let since = 0;
  let timer: unknown = null;
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  /** (re)start the wait: holdMs from now, never past since + maxMs */
  const arm = () => {
    stop();
    timer = setTimer(
      () => {
        timer = null;
        release();
      },
      Math.max(0, Math.min(o.holdMs, since + maxMs - now())),
    );
  };
  const release = (extra = "") => {
    const text = [held, extra.trim()].filter(Boolean).join(" ");
    const was = held;
    stop();
    held = "";
    // sent first: a steer it starts already counts when the change is seen
    if (text) o.send(text);
    if (was) o.onChange?.("");
  };
  return {
    final(text) {
      const t = text.trim();
      if (!t) return;
      const line = held ? `${held} ${t}` : t;
      if (o.holdMs > 0 && incomplete(line)) {
        if (!held) since = now();
        held = line;
        arm();
        o.onChange?.(held);
        return;
      }
      held = line;
      release();
    },
    interim() {
      if (held) arm();
    },
    flush(extra = "") {
      release(extra);
    },
    drop() {
      stop();
      if (held) {
        held = "";
        o.onChange?.("");
      }
    },
    held: () => held,
  };
}
