import type { AgentPatch, AgentProfile } from "@pickle/protocol";

/**
 * What 모시 settings send and show while another device may change the same profile (G2): only the fields changed
 * here go out (the server merges them into the profile it holds), and switches still waiting for their answer stay on
 * top of whatever the server says meanwhile.
 */

/** 저장하기 on name and persona: only what differs from the server's copy (an untouched field may have moved elsewhere) */
export function namePatch(agent: Pick<AgentProfile, "name" | "persona">, name: string, persona: string): AgentPatch {
  const patch: AgentPatch = {};
  if (name.trim() !== agent.name) patch.name = name.trim();
  if (persona.trim() !== agent.persona) patch.persona = persona.trim();
  return patch;
}

export interface SkillToggle {
  id: string;
  on: boolean;
}

/** the server's enabled list with this device's waiting toggles applied in the order they were made */
export function withToggles(enabled: readonly string[], toggles: readonly SkillToggle[]): string[] {
  return toggles.reduce<string[]>((list, t) => (t.on ? (list.includes(t.id) ? list : [...list, t.id]) : list.filter((x) => x !== t.id)), [...enabled]);
}

/** one switch, not the whole list: the server merges it into the list it holds (a switch elsewhere stays) */
export const togglePatch = (t: SkillToggle): AgentPatch => ({ skills: { [t.id]: t.on } });
