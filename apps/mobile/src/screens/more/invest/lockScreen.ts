import { browserPush, isVapidKey, keyBytes, syncPush, type PushDeps, type PushState } from "../../../app/push";
import type { LockScreen } from "./rules";

/**
 * This device's lock-screen notifications for 투자 설정 (DD 0059 §5-4): `none` while the server sends none (its key
 * answers 503 push_off or 404, or cannot be read: no row, no promise it cannot keep, lead 2331b), else `unsupported`
 * where Web Push is not on this device, `on` once the permission is granted and the subscription is with the server
 * (the app's own syncPush, which it runs on every start too), else `off`. Nothing here asks for the permission: the
 * row leads to 알림 설정, the one place that does (DD 2330).
 */
export async function readLockScreen(deps: Pick<PushDeps, "supported" | "permission" | "getKey"> = browserPush, sync: () => Promise<PushState> = syncPush): Promise<LockScreen> {
  let publicKey: unknown;
  try {
    ({ publicKey } = await deps.getKey());
  } catch {
    return "none";
  }
  if (!isVapidKey(keyBytes(typeof publicKey === "string" ? publicKey : ""))) return "none";
  if (!deps.supported()) return "unsupported";
  if (deps.permission() !== "granted") return "off";
  return (await sync()) === "subscribed" ? "on" : "off";
}
