/** Small shared helpers: ids, hashing, Korean particles, HTML escaping. */

const B64URL = /[+/=]/g;

export function randomB64url(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(buf).toString("base64").replace(B64URL, (c) => (c === "+" ? "-" : c === "/" ? "_" : ""));
}

/** Prefixed random id, e.g. `t_3fK9…` (16 random bytes → 22 chars). */
export function newId(prefix: string): string {
  return `${prefix}_${randomB64url(16)}`;
}

export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Constant-time string comparison (length leak only). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

// ───────────── Korean particles (josa) ─────────────

function lastHangulHasBatchim(word: string): boolean | null {
  const trimmed = word.trim();
  if (!trimmed) return null;
  const code = trimmed.charCodeAt(trimmed.length - 1);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  // digits / latin: approximate by pronunciation of the last char
  const ch = trimmed[trimmed.length - 1]!.toLowerCase();
  if ("013678".includes(ch)) return true; // 영, 일, 삼, 육, 칠, 팔
  if ("lmnr".includes(ch)) return true;
  return false;
}

/** Appends the right particle: josa("깽이", "이", "가") → "깽이가"; josa("하늘", "이", "가") → "하늘이". */
export function josa(word: string, withBatchim: string, withoutBatchim: string): string {
  const b = lastHangulHasBatchim(word);
  return word + (b === null ? withoutBatchim : b ? withBatchim : withoutBatchim);
}

/** "깽이와" / "하늘과" */
export const wa = (w: string) => josa(w, "과", "와");
/** "깽이가" / "하늘이" */
export const iGa = (w: string) => josa(w, "이", "가");
/** "깽이예요" / "하늘이에요" */
export const ieyo = (w: string) => josa(w, "이에요", "예요");
/** "깽이를" / "하늘을" */
export const eulReul = (w: string) => josa(w, "을", "를");

// ───────────── text ─────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function escapeXml(s: string): string {
  return escapeHtml(s);
}

/** One-line preview for thread subtitles / notifications. */
export function preview(text: string, max = 48): string {
  const one = text
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? Math.trunc(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
