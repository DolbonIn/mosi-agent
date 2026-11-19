import type { DeviceRegistration, SessionBootstrap, SignupRequest } from "@pickle/protocol";
import { getOrCreateDeviceKey } from "@pickle/vault/client";
import { setToken } from "./client";
import * as ep from "./endpoints";
import { connectEvents } from "./events";
import { applySession, applyUi } from "./store";

/**
 * Auth: token in localStorage "pickle.token" (in-memory in private mode), device registration with the
 * non-extractable ECDSA P-256 key from @pickle/vault/client (used later to sign approvals).
 */
export { clearToken, getToken, setToken } from "./client";
export { logout, resetSession } from "./store";

/** "iPhone Safari", "Android Chrome", "Mac Chrome", "iPhone 카카오톡" … */
export function deviceLabel(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  const touchMac = typeof navigator !== "undefined" && /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || touchMac
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : "웹";
  const app = /KAKAOTALK/i.test(ua)
    ? "카카오톡"
    : /NAVER\(inapp/i.test(ua)
      ? "네이버"
      : /Instagram/i.test(ua)
        ? "인스타그램"
        : /SamsungBrowser/.test(ua)
          ? "Samsung Internet"
          : /Edg\//.test(ua)
            ? "Edge"
            : /Whale\//.test(ua)
              ? "Whale"
              : /Firefox|FxiOS/.test(ua)
                ? "Firefox"
                : /CriOS|Chrome\//.test(ua)
                  ? "Chrome"
                  : /Safari\//.test(ua)
                    ? "Safari"
                    : "브라우저";
  return `${device} ${app}`;
}

/** This device's registration (id + public signing JWK). The private key never leaves IndexedDB. */
export async function deviceRegistration(): Promise<DeviceRegistration> {
  const key = await getOrCreateDeviceKey();
  return { id: key.id, label: deviceLabel(), signingKey: key.publicJwk };
}

function afterAuth(token: string, session: SessionBootstrap): SessionBootstrap {
  setToken(token);
  applySession(session);
  ep.uiDefinitions()
    .then(applyUi)
    .catch(() => {});
  connectEvents();
  return session;
}

/** Create the account + agent. Throws ApiError (Korean message) on failure; the form keeps its input. */
export async function signup(req: Omit<SignupRequest, "device">): Promise<SessionBootstrap> {
  const device = await deviceRegistration();
  const res = await ep.signup({ ...req, device });
  return afterAuth(res.token, res.session);
}

export async function login(handle: string, password: string): Promise<SessionBootstrap> {
  const device = await deviceRegistration();
  const res = await ep.login({ handle, password, device });
  return afterAuth(res.token, res.session);
}

/** password reset, step 1: the server sends a code to the account's verified phone (409 no_verified_phone otherwise) */
export function resetStart(handle: string) {
  return ep.resetStart(handle);
}

/** password reset, step 2: the code and the new password; signs in like login */
export async function resetVerify(handle: string, code: string, password: string): Promise<SessionBootstrap> {
  const device = await deviceRegistration();
  const res = await ep.resetVerify({ handle, code, password, device });
  return afterAuth(res.token, res.session);
}
