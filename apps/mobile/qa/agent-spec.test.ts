import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentProfile, AvatarSpec, SessionBootstrap } from "@pickle/protocol";

/**
 * The server's agent spec is the one character (onboarding/state.ts): the device copy is only a preview before an
 * account, and every session the app holds (sign-up, login, a reload with a token, an account made elsewhere, an edit
 * in 나의 모시) overwrites it.
 */

const mem = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  get length() {
    return mem.size;
  },
} as Storage;

const { sessionStore, applyAgent } = await import("../src/api/store");
const { deviceAgentSpec } = await import("../src/screens/chat/onboarding/state");

const agent = (avatar: AvatarSpec): AgentProfile =>
  ({ id: "a1", name: "깽이", persona: "", avatar, model: "", status: "idle", enabledSkills: [], createdAt: "", lastActiveAt: null }) as AgentProfile;
const session = (avatar: AvatarSpec) => ({ agent: agent(avatar) }) as unknown as SessionBootstrap;
const stored = () => JSON.parse(mem.get("pickle.agentSpec") ?? "null") as AvatarSpec | null;

describe("agent spec: the server's is the one", () => {
  beforeEach(() => sessionStore.set({ status: "anon", session: null }));

  test("before an account: one preview per device, from the small set, kept", () => {
    const a = deviceAgentSpec();
    expect([8, 28, 96, 168, 205, 262, 322]).toContain(a.hue);
    expect(deviceAgentSpec()).toEqual(a);
    expect(stored()).toEqual(a);
  });

  test("a session arriving (login / reload / account made elsewhere) overwrites the preview", () => {
    const preview = deviceAgentSpec();
    const own: AvatarSpec = { hue: preview.hue === 8 ? 205 : 8, shape: "blob", eyes: "dot" };
    sessionStore.set({ status: "ready", session: session(own) });
    expect(deviceAgentSpec()).toEqual(own);
    expect(stored()).toEqual(own);
  });

  test("an edit of the agent (PATCH /api/agent → applyAgent) follows too", () => {
    sessionStore.set({ status: "ready", session: session({ hue: 96, shape: "blob", eyes: "dot" }) });
    applyAgent(agent({ hue: 322, shape: "round", eyes: "smile" }));
    expect(deviceAgentSpec()).toEqual({ hue: 322, shape: "round", eyes: "smile" });
    expect(stored()?.hue).toBe(322);
  });

  test("signing out keeps the last account's character as this device's preview", () => {
    sessionStore.set({ status: "ready", session: session({ hue: 168, shape: "blob", eyes: "dot" }) });
    sessionStore.set({ status: "anon", session: null });
    expect(deviceAgentSpec().hue).toBe(168);
  });

  test("a malformed spec from the server is ignored", () => {
    sessionStore.set({ status: "ready", session: session({ hue: 28, shape: "blob", eyes: "dot" }) });
    sessionStore.set({ status: "ready", session: session({ hue: Number.NaN, shape: "blob", eyes: "dot" }) });
    expect(deviceAgentSpec().hue).toBe(28);
  });
});
