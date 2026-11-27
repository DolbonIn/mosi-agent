import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/api/client";
import type { PushState } from "../src/app/push";
import { readLockScreen } from "../src/screens/more/invest/lockScreen";

// a 65-byte uncompressed P-256 point (0x04 + 64 bytes), base64url without padding
const KEY = Buffer.from(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i))).toString("base64url");

type Deps = Parameters<typeof readLockScreen>[0];
const deps = (o: Partial<{ supported: boolean; permission: NotificationPermission; key: () => Promise<{ publicKey: string }> }> = {}): Deps => ({
  supported: () => o.supported ?? true,
  permission: () => o.permission ?? "granted",
  getKey: o.key ?? (() => Promise.resolve({ publicKey: KEY })),
});
const syncs: string[] = [];
const sync = (state: PushState) => () => {
  syncs.push(state);
  return Promise.resolve(state);
};

describe("잠금 화면 알림 (DD 0059 §5-4)", () => {
  test("the server sends none (503 push_off, 404, unreachable, a bad key): no row, whatever the device", async () => {
    for (const err of [new ApiError(503, "push_off", "x"), new ApiError(404, "not_found", "x"), new Error("network")]) {
      expect(await readLockScreen(deps({ key: () => Promise.reject(err) }), sync("subscribed"))).toBe("none");
      expect(await readLockScreen(deps({ supported: false, key: () => Promise.reject(err) }), sync("subscribed"))).toBe("none");
    }
    expect(await readLockScreen(deps({ key: () => Promise.resolve({ publicKey: "BAEC" }) }), sync("subscribed"))).toBe("none");
  });
  test("a device without Web Push: 받을 수 없어요", async () => {
    expect(await readLockScreen(deps({ supported: false }), sync("subscribed"))).toBe("unsupported");
  });
  test("granted and with the server: on; granted but not subscribed: off; never asked or denied: off without syncing", async () => {
    syncs.length = 0;
    expect(await readLockScreen(deps(), sync("subscribed"))).toBe("on");
    for (const st of ["error", "invalid", "off"] as const) expect(await readLockScreen(deps(), sync(st))).toBe("off");
    expect(syncs).toEqual(["subscribed", "error", "invalid", "off"]);
    syncs.length = 0;
    expect(await readLockScreen(deps({ permission: "default" }), sync("subscribed"))).toBe("off");
    expect(await readLockScreen(deps({ permission: "denied" }), sync("subscribed"))).toBe("off");
    expect(syncs).toEqual([]);
  });
});
