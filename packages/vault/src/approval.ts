/**
 * Device-signed approvals: the device signs `approve:<approvalId>:<nonce>` with its
 * non-extractable ECDSA P-256 key (see client.ts `signApproval`). A valid signature lets the
 * server mark the resulting access as `deviceVerified` ("이 기기의 키로 확인했어요").
 */
import { b64urlDecode, publicEcJwk, utf8 } from "./encoding";

/** ECDSA P-256 / SHA-256 over utf8(`approve:${approvalId}:${nonce}`); signature = base64url(r||s), IEEE P1363. */
export async function verifyApproval(
  publicJwk: JsonWebKey,
  approvalId: string,
  nonce: string,
  signatureB64url: string,
): Promise<boolean> {
  try {
    if (!approvalId || !nonce) return false;
    const sig = b64urlDecode(signatureB64url);
    if (sig.byteLength !== 64) return false;
    const key = await globalThis.crypto.subtle.importKey(
      "jwk",
      publicEcJwk(publicJwk),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      sig,
      utf8(`approve:${approvalId}:${nonce}`),
    );
  } catch {
    return false;
  }
}
