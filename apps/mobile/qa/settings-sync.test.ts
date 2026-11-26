import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentProfile, ServerEvent, SessionBootstrap, UserSettings } from "@pickle/protocol";
import { namePatch, togglePatch, withToggles } from "../src/screens/more/agent/agentEdits";

/**
 * One person's devices see the same settings and 모시 profile (G2/G3). Another device's change arrives as a `settings` /
 * `agent` event with the server's change number (`rev`); this device applies it like a change made here (theme through
 * its one crossfade) and sends nothing back; a field one of its own PATCHes is still waiting on keeps its value; a copy
 * older than the one held (an answer or a re-read crossing an event) is dropped; `hello` after a reconnect re-reads
 * the session when the numbers moved. Drives the real events.ts dispatch through a fake EventSource; fetch is faked.
 * bun runs every test file in one process: the file starts and ends with resetSession and puts back what it stubbed.
 */

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.readyState = 2;
  }
}

type Held = { method: string; url: string; body: unknown; resolve: (r: Response) => void };
const held: Held[] = [];
let sessionGets = 0;
/** what GET /api/session answers (taken when the request comes in); `holdSession` keeps the answer back */
let serverSession: SessionBootstrap;
let holdSession: Promise<void> | null = null;
let viewTransitions = 0;

const realFetch = globalThis.fetch;
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
const realDocument = (globalThis as { document?: unknown }).document;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

const settings = (over: { rev: number } & Partial<{ [K in keyof UserSettings]: Partial<UserSettings[K]> }>): UserSettings => {
  const base: UserSettings = {
    notifications: { briefing: false, taskDone: true, friendMessages: true, marketing: false, briefingTime: "07:30" },
    privacy: { friendsCanSeeSchedule: false, friendsCanAskMyPickle: true, shareLocation: false, memoryEnabled: true },
    display: { theme: "system", reduceMotion: "system", reduceTransparency: "system", textScale: 1 },
    confirmBeforeSend: true,
  };
  const out = { ...base, rev: over.rev } as UserSettings & { rev: number };
  for (const k of ["notifications", "privacy", "display"] as const) if (over[k]) (out as Record<string, unknown>)[k] = { ...base[k], ...over[k] };
  return out;
};
const agent = (rev: number, over: Partial<AgentProfile> = {}): AgentProfile =>
  ({
    id: "u_haneul",
    name: "모시",
    persona: "다정하게 말해요",
    avatar: { hue: 210 },
    model: "qa",
    status: "idle",
    enabledSkills: ["web_search", "weather"],
    createdAt: 1,
    lastActiveAt: null,
    ...over,
    rev,
  }) as unknown as AgentProfile;
const session = (s: UserSettings, a: AgentProfile): SessionBootstrap =>
  ({
    user: { id: "u_haneul", handle: "haneul", displayName: "하늘" },
    agent: a,
    quota: { usedTokens: 0, limitTokens: 1000, usedPct: 0, resetsAt: 0 },
    tickets: { basic: 0, premium: 0 },
    settings: s,
    mainThreadId: "t_main",
    unreadThreads: 0,
    server: { llm: "configured", model: null, version: "qa" },
  }) as unknown as SessionBootstrap;

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (method === "GET" && /\/api\/session$/.test(url)) {
    sessionGets++;
    const body = JSON.stringify(serverSession);
    if (holdSession) await holdSession;
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (method === "PATCH") return new Promise<Response>((resolve) => held.push({ method, url, body: JSON.parse(String(init?.body ?? "{}")), resolve }));
  return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
}) as unknown as typeof fetch;

const push = (e: ServerEvent | Record<string, unknown>) => FakeEventSource.last!.onmessage!({ data: JSON.stringify(e) } as MessageEvent<string>);
const patches = (path: string) => held.filter((h) => h.url.endsWith(path)).length;

let store: typeof import("../src/api/store");
let tier: typeof import("../src/motion/tier");
const shown = () => store.settingsStore.get()!;

beforeAll(async () => {
  store = await import("../src/api/store");
  tier = await import("../src/motion/tier");
  const { island } = await import("../src/app/island");
  store.resetSession();
  island.clearBanners();
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = fakeFetch;
  const { setToken } = await import("../src/api/client");
  setToken("qa-token");
  serverSession = session(settings({ rev: 1 }), agent(1));
  store.applySession(serverSession);
  const { connectEvents } = await import("../src/api/events");
  connectEvents();
  expect(FakeEventSource.last?.url).toContain("/api/events?token=");
  // installed after connecting, so events.ts binds no page lifecycle that outlives this file: the root the display
  // prefs write to, and the View Transition a theme change crossfades through (MOTION-SPEC §6.12)
  (globalThis as { document?: unknown }).document = {
    documentElement: { dataset: {} as Record<string, string>, style: { setProperty() {} } },
    querySelector: () => null,
    startViewTransition(cb: () => void) {
      viewTransitions++;
      cb();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    },
  };
});
afterAll(async () => {
  const { island } = await import("../src/app/island");
  store.resetSession();
  island.clearBanners();
  // the display prefs the events set live in tier.ts for the whole process: back to the defaults while the root stub is
  // still in place, so a later file's settings do not differ from them (that would call setDisplayPrefs with no document)
  tier.setDisplayPrefs({ ...tier.DEFAULT_DISPLAY });
  await tick(); // the theme crossfade's `finished` clears its root flag a tick later
  globalThis.fetch = realFetch;
  const g = globalThis as Record<string, unknown>;
  for (const [k, v] of [["EventSource", realEventSource], ["document", realDocument]] as const) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

describe("settings from another device (G3)", () => {
  test("applied like a change made here: the theme through its one crossfade, the text size at once; nothing is sent back", async () => {
    const vt = viewTransitions;
    push({ type: "settings", settings: settings({ rev: 2, display: { theme: "dark", textScale: 1.2 } }) });
    expect(shown().display.theme).toBe("dark");
    expect(tier.getTier().prefs.theme).toBe("dark");
    expect(tier.getTier().prefs.textScale).toBe(1.2);
    expect(viewTransitions).toBe(vt + 1);
    await tick();
    expect(held.length).toBe(0);
  });

  test("a field this device is still waiting on keeps its value; the event's other fields come in", async () => {
    const seen: boolean[] = [];
    const unsub = store.settingsStore.subscribe(() => seen.push(shown().privacy.shareLocation));
    const run = store.updateSettings({ privacy: { shareLocation: true } });
    await tick();
    expect(patches("/api/settings")).toBe(1);
    // A turned the briefing on before the server took this device's PATCH: its event still says shareLocation false
    push({ type: "settings", settings: settings({ rev: 3, notifications: { briefing: true }, display: { theme: "dark", textScale: 1.2 } }) });
    expect(shown().privacy.shareLocation).toBe(true);
    expect(shown().notifications.briefing).toBe(true);
    held.at(-1)!.resolve(json(settings({ rev: 4, privacy: { shareLocation: true }, notifications: { briefing: true }, display: { theme: "dark", textScale: 1.2 } })));
    await run;
    unsub();
    expect(shown().privacy.shareLocation).toBe(true);
    expect(seen.every((v) => v)).toBe(true);
    expect(patches("/api/settings")).toBe(1);
  });

  test("both devices turn the same switch on at once: no frame shows it off, in either arrival order", async () => {
    const seen: string[] = [];
    const unsub = store.settingsStore.subscribe(() => seen.push(shown().display.reduceTransparency));
    // the other device's PATCH was taken first: its event (rev 5) comes before this device's answer (rev 6)
    let run = store.updateSettings({ display: { reduceTransparency: "on" } });
    await tick();
    push({ type: "settings", settings: settings({ rev: 5, notifications: { briefing: true }, privacy: { shareLocation: true }, display: { theme: "dark", textScale: 1.2, reduceTransparency: "on" } }) });
    held.at(-1)!.resolve(json(settings({ rev: 6, notifications: { briefing: true }, privacy: { shareLocation: true }, display: { theme: "dark", textScale: 1.2, reduceTransparency: "on" } })));
    await run;
    // and back off: this device's answer (rev 8) first, the other device's event (rev 7) late — dropped as older
    run = store.updateSettings({ display: { reduceTransparency: "off" } });
    await tick();
    held.at(-1)!.resolve(json(settings({ rev: 8, notifications: { briefing: true }, privacy: { shareLocation: true }, display: { theme: "dark", textScale: 1.2, reduceTransparency: "off" } })));
    await run;
    push({ type: "settings", settings: settings({ rev: 7, notifications: { briefing: true }, privacy: { shareLocation: true }, display: { theme: "dark", textScale: 1.2, reduceTransparency: "off" } }) });
    unsub();
    const firstOff = seen.indexOf("off");
    expect(seen.slice(0, firstOff).every((v) => v === "on")).toBe(true);
    expect(seen.slice(firstOff).every((v) => v === "off")).toBe(true);
    expect(tier.getTier().prefs.reduceTransparency).toBe("off");
  });

  test("an answer older than an event already applied does not undo it (the later choice on the other device wins)", async () => {
    const run = store.updateSettings({ notifications: { briefingTime: "08:00" } });
    await tick();
    // the server took this device's PATCH (rev 9), then the other device's 09:00 (rev 10); the event outruns the answer
    push({ type: "settings", settings: settings({ rev: 10, notifications: { briefing: true, briefingTime: "09:00" }, privacy: { shareLocation: true }, display: { theme: "dark", textScale: 1.2, reduceTransparency: "off" } }) });
    held.at(-1)!.resolve(json(settings({ rev: 9, notifications: { briefing: true, briefingTime: "08:00" }, privacy: { shareLocation: true }, display: { theme: "dark", textScale: 1.2, reduceTransparency: "off" } })));
    await run;
    expect(shown().notifications.briefingTime).toBe("09:00");
  });

  test("an event older than the copy held is dropped", () => {
    push({ type: "settings", settings: settings({ rev: 4, display: { theme: "light" } }) });
    expect(shown().display.theme).toBe("dark");
    expect(shown().notifications.briefingTime).toBe("09:00");
  });

  test("a PATCH that fails takes back only its own field: what an event brought meanwhile stays", async () => {
    const run = store.updateSettings({ notifications: { marketing: true } });
    await tick();
    push({ type: "settings", settings: settings({ rev: 11, notifications: { briefing: true, briefingTime: "09:30" }, privacy: { shareLocation: true }, display: { theme: "dark", textScale: 1.2, reduceTransparency: "off" } }) });
    expect(shown().notifications.marketing).toBe(true);
    held.at(-1)!.resolve(json({ error: "server_error", message: "잠시 후 다시 시도해 주세요" }, 500));
    await expect(run).rejects.toBeDefined();
    expect(shown().notifications.marketing).toBe(false);
    expect(shown().notifications.briefingTime).toBe("09:30");
  });

  test("a PATCH that fails while a newer one from this device still waits: the newer one's field keeps its value", async () => {
    const first = store.updateSettings({ privacy: { memoryEnabled: false } });
    const second = store.updateSettings({ notifications: { taskDone: false } });
    await tick();
    const [a, b] = held.slice(-2);
    a!.resolve(json({ error: "server_error", message: "잠시 후 다시 시도해 주세요" }, 500));
    await expect(first).rejects.toBeDefined();
    expect(shown().privacy.memoryEnabled).toBe(true);
    expect(shown().notifications.taskDone).toBe(false);
    b!.resolve(json({ error: "server_error", message: "잠시 후 다시 시도해 주세요" }, 500));
    await expect(second).rejects.toBeDefined();
    expect(shown().notifications.taskDone).toBe(true);
  });

  test("hello re-reads the session only when the server's numbers moved; the read merges by change number", async () => {
    const before = sessionGets;
    push({ type: "hello", at: 1, settingsRev: 11, agentRev: 1 });
    await tick();
    expect(sessionGets).toBe(before);
    // away while the other device changed the theme and 모시's name: the events were never seen here
    serverSession = session(settings({ rev: 12, notifications: { briefing: true, briefingTime: "09:30" }, privacy: { shareLocation: true }, display: { theme: "light", textScale: 1.2 } }), agent(2, { name: "하늘이" }));
    push({ type: "hello", at: 2, settingsRev: 12, agentRev: 2 });
    await tick();
    await tick();
    expect(sessionGets).toBe(before + 1);
    expect(shown().display.theme).toBe("light");
    expect(store.sessionStore.get().session?.agent.name).toBe("하늘이");
    expect(store.sessionStore.get().status).toBe("ready");
    expect(held.length).toBe(patches("/api/settings")); // still no PATCH from receiving
  });

  test("a re-read that left before a newer event does not undo the event", async () => {
    let release!: () => void;
    holdSession = new Promise<void>((r) => (release = r));
    serverSession = session(settings({ rev: 13, notifications: { briefing: true, briefingTime: "10:00" }, display: { theme: "light", textScale: 1.2 } }), agent(2, { name: "하늘이" }));
    push({ type: "hello", at: 3, settingsRev: 13, agentRev: 2 });
    await tick();
    push({ type: "settings", settings: settings({ rev: 14, notifications: { briefing: true, briefingTime: "10:30" }, display: { theme: "light", textScale: 1.2 } }) });
    release();
    holdSession = null;
    await tick();
    await tick();
    expect(shown().notifications.briefingTime).toBe("10:30");
  });

  test("a re-read that left before this device's own answer (a higher number) does not undo the answer", async () => {
    let release!: () => void;
    holdSession = new Promise<void>((r) => (release = r));
    serverSession = session(settings({ rev: 15, notifications: { briefing: true, briefingTime: "10:30" }, display: { theme: "light", textScale: 1.2 } }), agent(2, { name: "하늘이" }));
    push({ type: "hello", at: 4, settingsRev: 15, agentRev: 2 });
    await tick();
    const run = store.updateSettings({ notifications: { briefingTime: "11:00" } });
    await tick();
    held.at(-1)!.resolve(json(settings({ rev: 16, notifications: { briefing: true, briefingTime: "11:00" }, display: { theme: "light", textScale: 1.2 } })));
    await run;
    release();
    holdSession = null;
    await tick();
    await tick();
    expect(shown().notifications.briefingTime).toBe("11:00");
  });
});

describe("모시 profile from another device (G2)", () => {
  test("an agent event replaces the session's agent; an older copy (event, answer or re-read) is dropped", () => {
    push({ type: "agent", agent: agent(3, { name: "구름", avatar: { hue: 30 } as AgentProfile["avatar"] }) });
    expect(store.sessionStore.get().session?.agent.name).toBe("구름");
    push({ type: "agent", agent: agent(2, { name: "하늘이" }) });
    expect(store.sessionStore.get().session?.agent.name).toBe("구름");
    expect(store.applyAgent(agent(1, { name: "모시" }))).toBe(false);
    expect(store.sessionStore.get().session?.agent.avatar.hue).toBe(30);
  });

  test("a re-read that left before a newer agent event or 저장하기 answer does not undo it", async () => {
    const name = () => store.sessionStore.get().session?.agent.name;
    const now = settings({ rev: 16, notifications: { briefing: true, briefingTime: "11:00" }, display: { theme: "light", textScale: 1.2 } });
    let release!: () => void;
    holdSession = new Promise<void>((r) => (release = r));
    serverSession = session(now, agent(4, { name: "바람" }));
    push({ type: "hello", at: 5, settingsRev: 16, agentRev: 4 });
    await tick();
    push({ type: "agent", agent: agent(5, { name: "구름이" }) });
    release();
    holdSession = null;
    await tick();
    await tick();
    expect(name()).toBe("구름이");
    // the re-read (rev 6) is on its way while this device's 저장하기 answer (rev 7) lands
    holdSession = new Promise<void>((r) => (release = r));
    serverSession = session(now, agent(6, { name: "바다" }));
    push({ type: "hello", at: 6, settingsRev: 16, agentRev: 6 });
    await tick();
    expect(store.applyAgent(agent(7, { name: "노을" }))).toBe(true);
    release();
    holdSession = null;
    await tick();
    await tick();
    expect(name()).toBe("노을");
    expect(shown().notifications.briefingTime).toBe("11:00");
  });

  test("저장하기 sends only the fields changed here", () => {
    const a = { name: "구름", persona: "다정하게 말해요" };
    expect(namePatch(a, "  구름이 ", "다정하게 말해요")).toEqual({ name: "구름이" });
    expect(namePatch(a, "구름", "짧게 말해요 ")).toEqual({ persona: "짧게 말해요" });
    expect(namePatch(a, "바다", "짧게")).toEqual({ name: "바다", persona: "짧게" });
  });

  test("a switch sends itself alone; waiting switches stay on top of the server's list, in the order they were made", () => {
    expect(togglePatch({ id: "weather", on: false })).toEqual({ skills: { weather: false } });
    expect(togglePatch({ id: "calendar", on: true })).toEqual({ skills: { calendar: true } });
    // another device turned "memo" on meanwhile: it shows, and this device's two waiting switches stay as pressed
    const server = ["web_search", "weather", "memo"];
    expect(withToggles(server, [{ id: "weather", on: false }, { id: "calendar", on: true }])).toEqual(["web_search", "memo", "calendar"]);
    expect(withToggles(server, [{ id: "calendar", on: true }, { id: "calendar", on: false }])).toEqual(server);
    expect(withToggles(["web_search", "weather", "calendar"], [{ id: "calendar", on: true }])).toEqual(["web_search", "weather", "calendar"]);
  });
});

describe("app start", () => {
  test("a reload or a login takes the session as it comes, whatever the numbers; later copies count from it", () => {
    const name = () => store.sessionStore.get().session?.agent.name;
    store.applySession(session(settings({ rev: 1, display: { theme: "system", textScale: 1 } }), agent(1, { name: "모시" })));
    expect(shown().display.theme).toBe("system");
    expect(shown().notifications.briefingTime).toBe("07:30");
    expect(name()).toBe("모시");
    push({ type: "settings", settings: settings({ rev: 2, display: { theme: "dark" } }) });
    expect(shown().display.theme).toBe("dark");
    push({ type: "agent", agent: agent(2, { name: "하늘이" }) });
    expect(name()).toBe("하늘이");
    expect(held.length).toBe(patches("/api/settings"));
  });
});
