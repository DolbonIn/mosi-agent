import { islandStore, island, type AgentKind, type IslandState } from "./island";
import { shallowEqual, useStore } from "../lib/createStore";

export { toolLabel, toolSource, stepsSummary } from "./agentVocab";

/**
 * The agent-state vocabulary (MOTION-SPEC §8.3, research §3-0) as the screens see it — one store shared by the
 * Dynamic Island, the composer (send ↔ stop), tool chips and the Shell's polite live region (<AgentLive/>).
 * It is a view over app/island.ts (the island's store); `sendMessage`, `decideApproval`, `stopTurn` and
 * `navigator.onLine` drive it.
 *
 *   const s = useAgentState()            // { kind, label, tool, threadId, elapsedS, slow, level }
 *   agentState.set("listening")           // or "thinking" | "tool" (p.tool) | "streaming" | "awaiting_approval" | "done" …
 *   agentState.level(0.4)                 // real values only: mic input level (listening / call) or token rate (streaming)
 *   agentState.pulse()                    // an event arrived → resets the 15 s "오래 걸리고 있어요 · 멈추기" timer
 *   setIslandTapHandler((s) => …)         // e.g. awaiting_approval → scroll to the card
 */
export type AgentStateKind = AgentKind;

export interface AgentStateView {
  kind: AgentStateKind;
  /** Korean status text ("" for idle and during the first second of thinking); toolLabel() for "tool" */
  label: string;
  /** tool name while kind === "tool" */
  tool?: string;
  threadId?: string;
  /** whole seconds in this state once ≥ 2 s (0 before — show it only when > 0) */
  elapsedS: number;
  /** ≥ 15 s without any event while a turn runs → "오래 걸리고 있어요 · 멈추기" */
  slow: boolean;
  /** 0..1 from a real source only */
  level: number;
}

function view(s: IslandState): AgentStateView {
  return {
    kind: s.kind,
    label: s.text,
    tool: s.tool ?? undefined,
    threadId: s.threadId ?? undefined,
    elapsedS: s.elapsed,
    slow: s.stalled,
    level: s.kind === "call" ? (s.call?.amplitude ?? s.level) : s.level,
  };
}

export function useAgentState(): AgentStateView {
  return useStore(islandStore, view, shallowEqual);
}
export const getAgentState = (): AgentStateView => view(islandStore.get());

export const agentState = {
  set(kind: AgentStateKind, p: { tool?: string; threadId?: string; label?: string } = {}) {
    switch (kind) {
      case "idle":
        island.idle();
        return;
      case "listening":
        island.listening();
        return;
      case "thinking":
        island.thinking(p.threadId ?? islandStore.get().threadId);
        return;
      case "tool":
        island.tool(p.tool ?? "", p.label);
        return;
      case "streaming":
        island.streaming();
        return;
      case "awaiting_approval":
        island.awaitingApproval(p.label);
        return;
      case "done":
        island.done(p.label);
        return;
      case "error":
        island.error(p.label);
        return;
      case "offline":
        island.offline(true);
        return;
      case "call":
        island.callState(p.threadId);
        return;
    }
  },
  /** real level 0..1: mic input (listening / call) or token rate (streaming) */
  level(v: number) {
    island.level(v);
  },
  /** an event arrived for the running turn */
  pulse() {
    island.event();
  },
};

/** what tapping the island does (besides call / stall / error, which the island handles itself) */
export function setIslandTapHandler(fn: ((s: AgentStateView) => void) | null) {
  island.setTapHandler(fn ? () => fn(getAgentState()) : null);
}
