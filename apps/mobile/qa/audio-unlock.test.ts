import { afterAll, describe, expect, mock, test } from "bun:test";

// audioUnlock.ts on a fake browser: a counting AudioContext, an idle queue the test runs, window listeners the test
// fires, a device list and the page's sticky activation. Each prewarm case imports its own copy of the module.
const rec = { made: 0, resumed: 0, closed: 0, starts: [] as { len: number; to: string }[], idle: [] as (() => void)[], listed: 0, listedAt: [] as number[], madeAt: [] as number[] };
class FakeContext {
  state: AudioContextState = "suspended";
  readonly destination = { name: "destination" };
  constructor() {
    rec.made++;
    rec.madeAt.push(performance.now());
  }
  createGain() {
    return { connect() {} };
  }
  createAnalyser() {
    return { fftSize: 0, connect() {} };
  }
  createBuffer(_channels: number, length: number) {
    return { length };
  }
  createBufferSource() {
    const s = {
      buffer: null as { length: number } | null,
      to: "",
      connect(n: { name?: string }) {
        s.to = n.name ?? "node";
      },
      start() {
        rec.starts.push({ len: s.buffer?.length ?? 0, to: s.to });
      },
    };
    return s;
  }
  resume() {
    rec.resumed++;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    rec.closed++;
    this.state = "closed";
    return Promise.resolve();
  }
}
const listeners = new Map<string, Set<() => void>>();
const g = globalThis as Record<string, unknown>;
const hadWindow = "window" in g;
const oldWindow = g.window;
const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
g.window = {
  AudioContext: FakeContext,
  requestIdleCallback: (f: () => void) => rec.idle.push(f),
  addEventListener: (type: string, f: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(f);
  },
  removeEventListener: (type: string, f: () => void) => listeners.get(type)?.delete(f),
};
const nav: { mediaDevices?: { enumerateDevices: () => Promise<unknown[]> }; userActivation: { hasBeenActive: boolean } } = { userActivation: { hasBeenActive: false } };
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
const runIdle = () => {
  for (const f of rec.idle.splice(0)) f();
};
/** a tap: the page becomes active, and the window's click listeners hear it */
const tap = () => {
  nav.userActivation.hasBeenActive = true;
  for (const f of [...(listeners.get("click") ?? [])]) f();
};
const listening = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
const fresh = async (tag: string) => (await import(`../src/screens/chat/call/audioUnlock.ts?${tag}`)) as typeof import("../src/screens/chat/call/audioUnlock");
const reset = () => {
  Object.assign(rec, { made: 0, closed: 0, listed: 0, listedAt: [], madeAt: [] });
  rec.idle.length = 0;
  listeners.clear();
  nav.userActivation.hasBeenActive = false;
};
const withList = () => {
  nav.mediaDevices = {
    enumerateDevices: () => {
      rec.listed++;
      rec.listedAt.push(performance.now());
      return Promise.resolve([]);
    },
  };
};

const startCall = mock(() => {});
mock.module("../src/screens/chat/call/callStore", () => ({ startCall }));
const audio = await import("../src/screens/chat/call/audioUnlock");
const { launchCall } = await import("../src/screens/chat/call/launch");

afterAll(() => {
  if (hadWindow) g.window = oldWindow;
  else delete g.window;
  if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator);
});

describe("prewarmAudio", () => {
  test("without mediaDevices (an insecure origin) it warms nothing and makes no context", async () => {
    reset();
    delete nav.mediaDevices;
    const a = await fresh("insecure");
    nav.userActivation.hasBeenActive = true;
    a.prewarmAudio();
    runIdle();
    await Bun.sleep(1600);
    runIdle();
    expect(rec.made).toBe(0);
    expect(listening()).toBe(0);
  });

  test("step 1: the device list once, in an idle callback, with no gesture and no context", async () => {
    reset();
    withList();
    const a = await fresh("list");
    a.prewarmAudio();
    expect(rec.listed).toBe(0); // not inside the effect that mounted the thread
    runIdle();
    expect(rec.listed).toBe(1);
    a.prewarmAudio();
    runIdle();
    expect(rec.listed).toBe(1);
    // no gesture yet: no context, however long the page stays quiet (the old warm-up fired 1.5 s after mount)
    await Bun.sleep(1600);
    runIdle();
    expect(rec.made).toBe(0);
    expect(a.audioContext()).toBeNull();
  });

  test("step 2: after the first gesture, a throwaway context, closed at once, and only once", async () => {
    reset();
    withList();
    const a = await fresh("gesture");
    a.prewarmAudio();
    runIdle();
    await Bun.sleep(600);
    runIdle();
    expect(rec.made).toBe(0);
    expect(listening()).toBeGreaterThan(0);
    tap();
    tap(); // two taps before the browser is idle: still one context
    expect(rec.made).toBe(0); // not inside the tap either: in the next idle moment
    runIdle();
    expect(rec.made).toBe(1);
    expect(rec.closed).toBe(1);
    expect(a.audioContext()).toBeNull();
    expect(listening()).toBe(0);
    tap();
    runIdle();
    expect(rec.made).toBe(1);
  });

  test("a gesture before the list is back waits for it, and ~0.5 s more (a context made sooner is the slow one)", async () => {
    reset();
    withList();
    nav.userActivation.hasBeenActive = true;
    const a = await fresh("early");
    a.prewarmAudio();
    runIdle();
    await Bun.sleep(0);
    runIdle();
    expect(rec.listed).toBe(1);
    expect(rec.made).toBe(0);
    tap(); // another tap while the list is on its way
    runIdle();
    expect(rec.made).toBe(0);
    await Bun.sleep(100);
    runIdle();
    expect(rec.made).toBe(0);
    await Bun.sleep(500);
    runIdle();
    expect(rec.made).toBe(1);
    expect(rec.madeAt[0] - rec.listedAt[0]).toBeGreaterThanOrEqual(450);
  });

  test("a call tapped before step 2 makes the only context; step 2 then makes none", async () => {
    reset();
    withList();
    const a = await fresh("race");
    a.prewarmAudio();
    nav.userActivation.hasBeenActive = true;
    a.unlockAudio(); // the call tap, while the list is still on its way
    runIdle();
    await Bun.sleep(600);
    runIdle();
    expect(rec.made).toBe(1);
    expect(a.audioContext()).not.toBeNull();
    a.closeAudio();
  });
});

describe("unlockAudio and the call tap", () => {
  test("launchCall makes, resumes and unlocks the context synchronously, before the call chunk", async () => {
    const before = { made: rec.made, resumed: rec.resumed, starts: rec.starts.length };
    launchCall("t_qa");
    // still inside the tap: the context exists, is resuming, and a 1-sample silent buffer went to the speakers
    expect(rec.made - before.made).toBe(1);
    expect(rec.resumed - before.resumed).toBe(1);
    expect(rec.starts.slice(before.starts)).toEqual([{ len: 1, to: "destination" }]);
    expect(startCall).not.toHaveBeenCalled();
    await Bun.sleep(0);
    expect(startCall).toHaveBeenCalledTimes(1);
    expect(audio.audioGraph()?.ctx).toBe(audio.audioContext() as AudioContext);
  });

  test("one context per call: a second unlock reuses it, the next call after closeAudio makes a fresh one", () => {
    const made = rec.made;
    const first = audio.audioContext();
    expect(audio.unlockAudio()).toBe(first as AudioContext);
    expect(rec.made).toBe(made);
    audio.closeAudio();
    expect(audio.audioContext()).toBeNull();
    expect(audio.audioGraph()).toBeNull();
    const closed = rec.closed;
    const next = audio.unlockAudio();
    expect(rec.made).toBe(made + 1);
    expect(next).not.toBe(first as AudioContext);
    expect(rec.closed).toBe(closed); // the closed one is not closed again
    audio.closeAudio();
  });
});
