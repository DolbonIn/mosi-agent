/**
 * Errors thrown by the vault. `message` is a fixed, generic string — it never contains
 * plaintext, ciphertext, tokens or user input, so it is safe to log or return to clients.
 */
export type VaultErrorCode =
  | "envelope_invalid"
  | "envelope_version"
  | "envelope_alg"
  | "envelope_kid"
  | "envelope_aad"
  | "envelope_decrypt"
  | "enclave_key_invalid"
  | "master_key_invalid"
  | "invalid_request"
  | "credential_not_found"
  | "credential_expired"
  | "decrypt_failed";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}
