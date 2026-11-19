/**
 * @pickle/messengers/login — provider halves of the in-app login relay (Discord remote auth, Telegram phone login).
 * apps/server/src/messenger-login owns relay sessions, routes, rate limits and the vault hand-off.
 */
import { createRequire } from "node:module";
import { sharedTdRuntime, type TdRuntime } from "../tdlib/runtime";
import { telegramAppFromEnv, type TelegramApp } from "./telegram";
import type { LoginWithRemoteAuth } from "./discord";

export { DiscordRemoteAuth, bunSocket, type DiscordRemoteAuthOptions, type LoginWithRemoteAuth, type RemoteAuthSocket, type RemoteAuthUserLike } from "./discord";
export { TelegramLogin, telegramAppFromEnv, tdlibParameters, TELEGRAM_DIR, type TelegramApp, type TelegramLoginOptions } from "./telegram";
export { maskPhone, normalizePhone, TERMINAL, type LoginErrorCode, type LoginResult, type LoginView, type LoginViewState } from "./types";
export { TdClient, TdError, TdRuntime, loadTdJson, sharedTdRuntime, type TdJson, type TdObject } from "../tdlib/runtime";
export { userConfigDir } from "../sdk";

/**
 * The QR code for a remote-auth link as an SVG data URI (the app's CSP allows `data:` images, not remote ones).
 * Rendered with `qrcode` (MIT), agent-messenger's own dependency: nothing extra installed. Only discord.com/ra links.
 */
export async function qrSvgDataUri(url: string): Promise<string | null> {
  if (!/^https:\/\/discord\.com\/ra\/[A-Za-z0-9_-]{8,128}$/.test(url)) return null;
  try {
    const req = createRequire(import.meta.resolve("agent-messenger/package.json"));
    const QR = req("qrcode") as { toString(t: string, o: Record<string, unknown>): Promise<string> };
    const svg = await QR.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  } catch {
    return null;
  }
}

/** agent-messenger's `loginWithRemoteAuth`, imported on first use */
export async function loadDiscordRemoteAuth(): Promise<LoginWithRemoteAuth> {
  const mod = await import("agent-messenger/discord");
  return mod.loginWithRemoteAuth as unknown as LoginWithRemoteAuth;
}

export type TelegramReadiness = { ok: true; app: TelegramApp; runtime: TdRuntime } | { ok: false; reason: "not_configured" | "tdlib_missing" };

/**
 * Telegram user login needs the operator's api_id/api_hash (server env) AND a loadable libtdjson. Either missing →
 * the provider is listed as "준비 중".
 */
export async function telegramReadiness(env: Record<string, string | undefined> = process.env): Promise<TelegramReadiness> {
  const app = telegramAppFromEnv(env);
  if (!app) return { ok: false, reason: "not_configured" };
  try {
    return { ok: true, app, runtime: await sharedTdRuntime() };
  } catch {
    return { ok: false, reason: "tdlib_missing" };
  }
}
