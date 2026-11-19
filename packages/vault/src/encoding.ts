/**
 * Byte/string helpers shared by the server enclave and the browser client.
 * Browser-safe: no `node:` imports, no Buffer — only TextEncoder/TextDecoder/btoa/atob.
 */

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return enc.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto wants `BufferSource` over a plain ArrayBuffer). */
export function bytes(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
}

export function b64urlEncode(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new TypeError("invalid base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Best-effort wipe of a buffer that held plaintext. */
export function wipe(b: Uint8Array | ArrayBuffer | null | undefined): void {
  if (!b) return;
  (b instanceof Uint8Array ? b : new Uint8Array(b)).fill(0);
}

/** Only the public coordinates of an EC JWK (drops ext/key_ops/d) — stable across runtimes. */
export function publicEcJwk(jwk: JsonWebKey): JsonWebKey {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new TypeError("expected an EC P-256 public JWK");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** Canonical JSON (sorted keys, no whitespace) of a public EC JWK. */
export function canonicalJwk(jwk: JsonWebKey): string {
  const p = publicEcJwk(jwk);
  return `{"crv":${JSON.stringify(p.crv)},"kty":${JSON.stringify(p.kty)},"x":${JSON.stringify(p.x)},"y":${JSON.stringify(p.y)}}`;
}

/** Parse decrypted credential JSON; must be a flat object of string values. */
export function parseSecret(json: string): Record<string, string> {
  const v: unknown = JSON.parse(json);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new TypeError("secret must be an object");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") throw new TypeError("secret values must be strings");
    out[k] = val;
  }
  return out;
}
