/** In-memory `VaultStorage` for tests and local experiments (not persistent, not for production). */
import type { AccessRecord } from "@pickle/protocol";
import type { CredentialRow, VaultStorage } from "./vault";

export class MemoryVaultStorage implements VaultStorage {
  readonly rows = new Map<string, CredentialRow>();
  readonly userKeys = new Map<string, string>();
  readonly access = new Map<string, AccessRecord[]>();

  async insertCredential(row: CredentialRow): Promise<void> {
    this.rows.set(row.id, { ...row });
  }
  async getCredential(userId: string, id: string): Promise<CredentialRow | null> {
    const r = this.rows.get(id);
    return r && r.userId === userId ? { ...r } : null;
  }
  async listCredentials(userId: string): Promise<CredentialRow[]> {
    return [...this.rows.values()].filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }
  async updateCredential(userId: string, id: string, patch: Partial<CredentialRow>): Promise<void> {
    const r = this.rows.get(id);
    if (r && r.userId === userId) this.rows.set(id, { ...r, ...patch, id: r.id, userId: r.userId });
  }
  async deleteCredential(userId: string, id: string): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.userId !== userId) return false;
    return this.rows.delete(id);
  }
  async getWrappedUserKey(userId: string): Promise<string | null> {
    return this.userKeys.get(userId) ?? null;
  }
  async setWrappedUserKey(userId: string, wrapped: string): Promise<void> {
    if (!this.userKeys.has(userId)) this.userKeys.set(userId, wrapped);
  }
  async insertAccess(userId: string, rec: AccessRecord): Promise<void> {
    const list = this.access.get(userId) ?? [];
    list.push({ ...rec });
    this.access.set(userId, list);
  }
  async listAccess(userId: string, limit: number): Promise<AccessRecord[]> {
    return [...(this.access.get(userId) ?? [])].reverse().slice(0, limit);
  }
}
