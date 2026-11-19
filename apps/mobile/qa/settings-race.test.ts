import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UserSettings } from "@pickle/protocol";

/**
 * updateSettings under quick, overlapping changes (settings B QA): only the answer to the newest PATCH lands, the
 * optimistic value holds until then, and a failure rolls back only while it is still the newest request.
 */

const realFetch = globalThis.fetch;

const base = (): UserSettings => ({
  notifications: { briefing: false, taskDone: true, friendMessages: true, marketing: false, briefingTime: "07:30" },
  privacy: { friendsCanSeeSchedule: false, friendsCanAskMyPickle: true, shareLocation: false, memoryEnabled: true },
  display: { theme: "system", reduceMotion: "system", reduceTransparency: "system", textScale: 1 },
  confirmBeforeSend: true,
});

type Pending = { body: { notifications?: { briefingTime?: string } }; resolve: (r: Response) => void };
/** every PATCH waits until the test answers it; the "server" applies them in arrival order, like the real one */
function holdPatches() {
  const pending: Pending[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => pending.push({ body: JSON.parse(String(init?.body ?? "{}")), resolve }))) as unknown as typeof fetch;
  return pending;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  const { setToken } = await import("../src/api/client");
  const { settingsStore } = await import("../src/api/store");
  setToken("qa-token");
  settingsStore.set(base());
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  const { clearToken } = await import("../src/api/client");
  clearToken();
});

describe("updateSettings: overlapping changes", () => {
  test("three overlapping updates answered in reverse order end on the last value, with no step back on the way", async () => {
    const { updateSettings, settingsStore } = await import("../src/api/store");
    const pending = holdPatches();
    const times = ["07:40", "07:50", "08:00"];
    const runs = times.map((t) => updateSettings({ notifications: { briefingTime: t } }));
    await tick();
    expect(pending.length).toBe(3);
    expect(settingsStore.get()!.notifications.briefingTime).toBe("08:00");

    // the server applied all three in order; each answer is its state after that PATCH
    const seen: string[] = [];
    const unsub = settingsStore.subscribe(() => seen.push(settingsStore.get()!.notifications.briefingTime));
    const after = (t: string) => ({ ...base(), notifications: { ...base().notifications, briefingTime: t } });
    for (const i of [2, 1, 0]) {
      pending[i]!.resolve(json(after(times[i]!)));
      await runs[i];
      expect(settingsStore.get()!.notifications.briefingTime).toBe("08:00");
    }
    unsub();
    expect(seen.every((t) => t === "08:00")).toBe(true);
  });

  test("the older answers arriving after the newest one never overwrite it", async () => {
    const { updateSettings, settingsStore } = await import("../src/api/store");
    const pending = holdPatches();
    const a = updateSettings({ notifications: { briefingTime: "09:00" } });
    const b = updateSettings({ notifications: { briefingTime: "09:10" } });
    await tick();
    pending[1]!.resolve(json({ ...base(), notifications: { ...base().notifications, briefingTime: "09:10" } }));
    await b;
    pending[0]!.resolve(json({ ...base(), notifications: { ...base().notifications, briefingTime: "09:00" } }));
    await a;
    expect(settingsStore.get()!.notifications.briefingTime).toBe("09:10");
  });

  test("an older request failing does not roll back a newer choice", async () => {
    const { updateSettings, settingsStore } = await import("../src/api/store");
    const pending = holdPatches();
    const a = updateSettings({ privacy: { shareLocation: true } });
    const b = updateSettings({ notifications: { briefingTime: "10:00" } });
    await tick();
    pending[0]!.resolve(json({ error: "server_error", message: "잠시 후 다시 시도해 주세요" }, 500));
    await expect(a).rejects.toBeDefined();
    expect(settingsStore.get()!.notifications.briefingTime).toBe("10:00");
    // the newest answer carries the server's state (without the failed change)
    pending[1]!.resolve(json({ ...base(), notifications: { ...base().notifications, briefingTime: "10:00" } }));
    await b;
    expect(settingsStore.get()!.privacy.shareLocation).toBe(false);
    expect(settingsStore.get()!.notifications.briefingTime).toBe("10:00");
  });

  test("the newest request failing rolls back to what was there before it", async () => {
    const { updateSettings, settingsStore } = await import("../src/api/store");
    const pending = holdPatches();
    const a = updateSettings({ notifications: { briefingTime: "11:00" } });
    const b = updateSettings({ notifications: { briefingTime: "11:10" } });
    await tick();
    pending[0]!.resolve(json({ ...base(), notifications: { ...base().notifications, briefingTime: "11:00" } }));
    await a;
    expect(settingsStore.get()!.notifications.briefingTime).toBe("11:10");
    pending[1]!.resolve(json({ error: "server_error", message: "잠시 후 다시 시도해 주세요" }, 500));
    await expect(b).rejects.toBeDefined();
    expect(settingsStore.get()!.notifications.briefingTime).toBe("11:00");
  });
});
