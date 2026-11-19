/**
 * @pickle/vault — Credential Enclave (server side).
 * Browser helpers live in `@pickle/vault/client` (src/client.ts).
 */
export { Enclave, enclaveMeasurement, enclaveKid, ENCLAVE_ALG, ENCLAVE_HKDF_INFO } from "./enclave";
export { Vault, keepForToExpiry, type CredentialRow, type VaultStorage, type VaultOptions } from "./vault";
export { verifyApproval } from "./approval";
export { VaultError, type VaultErrorCode } from "./errors";
export { MemoryVaultStorage } from "./memory";
// legacy env-key helpers (keep exporting)
export { seal, open, type SealedSecret } from "./legacy";
