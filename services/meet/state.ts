// 참여 상태 기계. 계약 §2의 state 이벤트 값과 같다.
export type MeetState = "launching" | "prejoin" | "waiting_admission" | "in_call" | "ended" | "denied" | "blocked" | "invalid" | "failed";
export type EndReason = "left" | "kicked" | "meeting_ended" | "alone" | "error";

export const TERMINAL_STATES: ReadonlySet<MeetState> = new Set<MeetState>(["ended", "denied", "blocked", "invalid", "failed"]);

const NEXT: Record<MeetState, readonly MeetState[]> = {
  launching: ["prejoin", "invalid", "blocked", "failed", "ended"],
  prejoin: ["waiting_admission", "in_call", "invalid", "blocked", "denied", "failed", "ended"],
  waiting_admission: ["in_call", "denied", "blocked", "invalid", "failed", "ended"],
  in_call: ["ended", "failed"],
  ended: [],
  denied: [],
  blocked: [],
  invalid: [],
  failed: [],
};

export function isTerminal(s: MeetState): boolean {
  return TERMINAL_STATES.has(s);
}

export function canTransition(from: MeetState, to: MeetState): boolean {
  return NEXT[from].includes(to);
}

export interface StateChange {
  state: MeetState;
  reason?: string;
  from: MeetState;
}

export class StateMachine {
  state: MeetState = "launching";
  reason: string | undefined;
  private listeners = new Set<(c: StateChange) => void>();

  onChange(fn: (c: StateChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 허용되지 않는 전이는 무시하고 false. 같은 상태로의 전이도 false. */
  transition(to: MeetState, reason?: string): boolean {
    const from = this.state;
    if (from === to || !canTransition(from, to)) return false;
    this.state = to;
    this.reason = reason;
    const change: StateChange = { state: to, from, ...(reason ? { reason } : {}) };
    for (const fn of this.listeners) fn(change);
    return true;
  }

  get terminal(): boolean {
    return isTerminal(this.state);
  }
}

/** 실패 상태(denied/blocked/invalid/failed)로 끝나면 ended.reason은 "error". */
export function endReasonFor(state: MeetState, reason?: string): EndReason {
  if (state !== "ended") return "error";
  if (reason === "left" || reason === "kicked" || reason === "meeting_ended" || reason === "alone") return reason;
  return "error";
}
