/** UserSettings defaults + validated deep merge for PATCH /api/settings. */
import type { UserSettings } from "@pickle/protocol";
import { isRecord } from "./util.ts";

export function defaultSettings(): UserSettings {
  return {
    notifications: { briefing: true, investReport: true, taskDone: true, friendMessages: true, marketing: false, briefingTime: "07:30" },
    privacy: { friendsCanSeeSchedule: false, friendsCanAskMyPickle: true, shareLocation: false, memoryEnabled: true },
    display: { theme: "system", reduceMotion: "system", reduceTransparency: "system", textScale: 1 },
    confirmBeforeSend: true,
  };
}

type Validator = (v: unknown) => boolean;

const bool: Validator = (v) => typeof v === "boolean";
const oneOf =
  (...xs: string[]): Validator =>
  (v) => typeof v === "string" && xs.includes(v);
const hhmm: Validator = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const scale: Validator = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0.9 && v <= 1.3;

const SCHEMA: Record<string, Record<string, Validator> | Validator> = {
  notifications: { briefing: bool, investReport: bool, taskDone: bool, friendMessages: bool, marketing: bool, briefingTime: hhmm },
  privacy: { friendsCanSeeSchedule: bool, friendsCanAskMyPickle: bool, shareLocation: bool, memoryEnabled: bool },
  display: {
    theme: oneOf("system", "light", "dark"),
    reduceMotion: oneOf("system", "on", "off"),
    reduceTransparency: oneOf("system", "on", "off"),
    textScale: scale,
  },
  confirmBeforeSend: bool,
};

export class SettingsError extends Error {}

/** Merge a patch into current settings; throws SettingsError on unknown keys or bad values. */
export function mergeSettings(current: UserSettings, patch: unknown): UserSettings {
  if (!isRecord(patch)) throw new SettingsError("설정 형식이 올바르지 않아요");
  const next = structuredClone(current) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    const rule = SCHEMA[k];
    if (!rule) throw new SettingsError(`알 수 없는 설정이에요: ${k}`);
    if (typeof rule === "function") {
      if (!rule(v)) throw new SettingsError(`설정 값이 올바르지 않아요: ${k}`);
      next[k] = v;
      continue;
    }
    if (!isRecord(v)) throw new SettingsError(`설정 값이 올바르지 않아요: ${k}`);
    const section = { ...(next[k] as Record<string, unknown>) };
    for (const [sk, sv] of Object.entries(v)) {
      const check = rule[sk];
      if (!check) throw new SettingsError(`알 수 없는 설정이에요: ${k}.${sk}`);
      if (!check(sv)) throw new SettingsError(`설정 값이 올바르지 않아요: ${k}.${sk}`);
      section[sk] = sv;
    }
    next[k] = section;
  }
  return next as unknown as UserSettings;
}

/** Fill missing keys from defaults (older rows / forward compatibility). */
export function normalizeSettings(raw: unknown): UserSettings {
  const d = defaultSettings();
  if (!isRecord(raw)) return d;
  const out = d as unknown as Record<string, unknown>;
  for (const [k, rule] of Object.entries(SCHEMA)) {
    const v = raw[k];
    if (typeof rule === "function") {
      if (rule(v)) out[k] = v;
      continue;
    }
    if (!isRecord(v)) continue;
    const section = out[k] as Record<string, unknown>;
    for (const [sk, check] of Object.entries(rule)) if (check(v[sk])) section[sk] = v[sk];
  }
  return d;
}
