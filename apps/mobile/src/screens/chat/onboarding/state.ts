import type { AvatarSpec } from "@pickle/protocol";
import { getToken } from "../../../api/client";
import { sessionStore, type SessionStatus } from "../../../api/store";
import { createStore, useStore } from "../../../lib/createStore";

/**
 * Onboarding gate state.
 *  - `hold` keeps the onboarding on screen after the server confirmed sign-up/login until its own exit has played
 *    (the session is already "ready" by then).
 *  - `/?invite=<token>` is captured once at load (kept in sessionStorage so it survives sign-up and reloads), then
 *    accepted right after auth (ChatTab).
 */
export const onboardingHold = createStore(false);
export const useOnboardingHold = () => useStore(onboardingHold);

export function showsOnboarding(status: SessionStatus, hold: boolean): boolean {
  if (hold) return true;
  if (status === "anon" || status === "error") return true;
  return status === "unknown" && !getToken();
}

const KEY = "pickle.invite";
let memInvite: string | null = null;

function capture() {
  if (typeof location === "undefined") return;
  const params = new URLSearchParams(location.search);
  const token = params.get("invite");
  if (!token || !/^[A-Za-z0-9_-]{6,128}$/.test(token)) return;
  memInvite = token;
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* private mode: memory only */
  }
  params.delete("invite");
  const q = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
}
capture();

export function pendingInvite(): string | null {
  try {
    return sessionStorage.getItem(KEY) ?? memInvite;
  } catch {
    return memInvite;
  }
}

export function clearInvite() {
  memInvite = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The character met on the first screen is the one that stays (critique P2-1). The server's agent spec (`/api/agent`
 * avatar) is the one source of the character; this device copy is only the preview before there is an account:
 *  - before sign-up: picked once per device (hue from a small set, round eyes "dot"), shown on the hero, the sign-up
 *    stage and next to the name field — never sent anywhere until sign-up, which saves the one on screen;
 *  - from then on it follows the server: every session the app holds (sign-up, login, a reload with a token, an
 *    account made elsewhere, an edit in 나의 모시) writes its agent's spec here, so a later visit to this screen shows
 *    that account's character, not a stale or random one.
 */
const SPEC_KEY = "pickle.agentSpec";
const HUES = [8, 28, 96, 168, 205, 262, 322];
let memSpec: AvatarSpec | null = null;

function validSpec(v: unknown): v is AvatarSpec {
  const s = v as AvatarSpec | null;
  return !!s && typeof s.hue === "number" && Number.isFinite(s.hue) && ["blob", "round", "drop"].includes(s.shape) && ["dot", "oval", "smile"].includes(s.eyes);
}

export function rememberAgentSpec(spec: AvatarSpec) {
  memSpec = { hue: Math.round(spec.hue), shape: spec.shape, eyes: spec.eyes };
  try {
    localStorage.setItem(SPEC_KEY, JSON.stringify(memSpec));
  } catch {
    /* private mode: memory only */
  }
}

export function deviceAgentSpec(): AvatarSpec {
  if (memSpec) return memSpec;
  try {
    const raw = localStorage.getItem(SPEC_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (validSpec(v)) return (memSpec = v);
  } catch {
    /* unreadable: pick a new one */
  }
  const spec: AvatarSpec = { hue: HUES[Math.floor(Math.random() * HUES.length)]!, shape: "blob", eyes: "dot" };
  rememberAgentSpec(spec);
  return spec;
}

// the session's agent is the truth: adopt its spec whenever it arrives or changes (App imports this module at start)
let adopted: AvatarSpec | null = null;
function adoptSessionSpec() {
  const a = sessionStore.get().session?.agent?.avatar;
  if (!a || a === adopted || !validSpec(a)) return;
  adopted = a;
  rememberAgentSpec(a);
}
adoptSessionSpec();
sessionStore.subscribe(adoptSessionSpec);
