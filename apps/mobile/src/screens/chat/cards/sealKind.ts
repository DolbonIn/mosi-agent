import type { CredentialField, ProviderInfo } from "@pickle/protocol";

/**
 * The vault kind a chat credential card seals its fields as (aad `${userId}:${service}:${kind}`). It has to be the
 * kind the server expects for that service, or the save is refused.
 * - The provider's own `kind` wins. Every k-skill service sends it: an API-key service (`auth: "api_key"`) is "token",
 *   and an id/password one such as 숲나들e is "login".
 * - An older server without `kind`: "token" for auth "token" or "api_key", else "login". This covers the messenger
 *   logins (KakaoTalk, LINE, Instagram, Webex, all "credentials") exactly as before.
 * - A card whose service is not in the provider list is a token when it asks for a field named "token".
 */
export function sealKindOf(provider: Pick<ProviderInfo, "auth" | "kind"> | undefined, fields: readonly Pick<CredentialField, "key">[]): "login" | "token" {
  if (provider) return provider.kind ?? (provider.auth === "token" || provider.auth === "api_key" ? "token" : "login");
  return fields.some((f) => f.key === "token") ? "token" : "login";
}
