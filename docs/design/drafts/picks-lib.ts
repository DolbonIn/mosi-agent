/*
 * Shared by serve.ts (POST /drafts/api/picks) and pick-status.ts (lead's status CLI). See APPLY.md for the flow.
 *
 * picks.json: { [feature]: { choice, memo, submittedAt, status, owner?, commit?, note?, updatedAt?, history: [...] } }
 * .picks.log: one JSON line per submitted pick, { at, feature, choice, memo } (gitignored; the lead watches it)
 * Both live in docs/design/drafts/ unless PICKS_DIR is set (test runs).
 */
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";

export const DRAFTS = import.meta.dir;
// PICKS_DIR (tests only): keep picks.json and .picks.log somewhere else, so a test run never touches the real ones
const PICKS_DIR = process.env.PICKS_DIR ? path.resolve(process.env.PICKS_DIR) : DRAFTS;
export const PICKS = path.join(PICKS_DIR, "picks.json");
export const LOG = path.join(PICKS_DIR, ".picks.log");
export const STATUSES = ["submitted", "applying", "review", "applied", "blocked"] as const;
export type Status = (typeof STATUSES)[number];
export const MEMO_MAX = 500;

export type PickCore = {
  choice: string;
  memo: string;
  submittedAt: string;
  status: Status;
  owner?: string;
  commit?: string;
  note?: string;
  updatedAt?: string;
};
export type Pick = PickCore & { history: PickCore[] };
export type Picks = Record<string, Pick>;

export function manifestFeatures(): Set<string> {
  const list = JSON.parse(readFileSync(path.join(DRAFTS, "manifest.json"), "utf8"));
  return new Set((Array.isArray(list) ? list : []).map((m: any) => String(m.feature)));
}

/** Variant ids a feature offers, from its meta.json ("A", "B" …). Empty when there is no draft yet. */
export function variantIds(feature: string): string[] {
  const p = path.join(DRAFTS, feature, "meta.json");
  if (!existsSync(p)) return [];
  try {
    const meta = JSON.parse(readFileSync(p, "utf8"));
    return (Array.isArray(meta.variants) ? meta.variants : [])
      .filter((v: any) => v && typeof v.id === "string")
      .map((v: any) => v.id.toUpperCase());
  } catch {
    return [];
  }
}

/** Free text from a person: line breaks kept, every other control / bidi-override character removed. */
export function cleanText(s: unknown): string {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .trim();
}
export const textLength = (s: string) => [...s].length;

/** Throws when picks.json exists but is not valid JSON, so a broken file is never silently replaced. */
export function readPicks(): Picks {
  if (!existsSync(PICKS)) return {};
  const raw = readFileSync(PICKS, "utf8").trim();
  if (!raw) return {};
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("picks.json is not an object");
  return data as Picks;
}

/** Atomic: write a temp file next to picks.json, then rename over it. */
export function writePicks(picks: Picks) {
  const tmp = `${PICKS}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(picks, null, 2) + "\n");
  renameSync(tmp, PICKS);
}

export function appendLog(line: { at: string; feature: string; choice: string; memo: string }) {
  appendFileSync(LOG, JSON.stringify(line) + "\n");
}

export function core(p: Pick): PickCore {
  const { history: _h, ...rest } = p;
  return rest;
}
