// The vault kind a chat credential card seals as (screens/chat/cards/sealKind.ts). Since 8d8b535 the k-skill services
// come as `auth: "api_key"` with `kind: "token"` (docs/architecture/KSKILL-CONNECTIONS.md); sealing those as "login"
// gave the wrong aad and the server refused the save. The messenger logins must seal exactly as they did before.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProviderInfo } from "@pickle/protocol";
import { sealKindOf } from "../src/screens/chat/cards/sealKind";

type P = Pick<ProviderInfo, "auth" | "kind">;
const pw = [{ key: "id" }, { key: "password" }];
const tok = [{ key: "token" }];

// packages/messengers/src/providers.ts at HEAD: id → auth (the messenger catalog sends no `kind`)
const MESSENGERS: Record<string, ProviderInfo["auth"]> = {
  kakaotalk: "credentials",
  slack: "token",
  slackbot: "token",
  discord: "token",
  discordbot: "token",
  telegram: "token",
  telegrambot: "token",
  line: "credentials",
  instagram: "credentials",
  teams: "oauth",
  webex: "credentials",
};
// the formula the card used before the fix
const before = (p: P | undefined, fields: { key: string }[]) => (p?.auth === "token" || (!p && fields.some((f) => f.key === "token")) ? "token" : "login");

test("a k-skill API-key service seals as token", () => {
  expect(sealKindOf({ auth: "api_key", kind: "token" }, [{ key: "client_id" }, { key: "client_secret" }])).toBe("token");
  // the bug: the old formula called this a login
  expect(before({ auth: "api_key", kind: "token" }, [{ key: "client_id" }])).toBe("login");
});

test("a k-skill id/password service seals as login", () => {
  expect(sealKindOf({ auth: "credentials", kind: "login" }, pw)).toBe("login");
});

test("the provider's own kind wins over its auth", () => {
  expect(sealKindOf({ auth: "token", kind: "login" }, tok)).toBe("login");
  expect(sealKindOf({ auth: "credentials", kind: "token" }, pw)).toBe("token");
});

test("an older server without kind: api_key and token are token, the rest login", () => {
  expect(sealKindOf({ auth: "api_key" }, [{ key: "api_key" }])).toBe("token");
  expect(sealKindOf({ auth: "token" }, tok)).toBe("token");
  expect(sealKindOf({ auth: "credentials" }, pw)).toBe("login");
  expect(sealKindOf({ auth: "oauth" }, [])).toBe("login");
  expect(sealKindOf({ auth: "none" }, [])).toBe("login");
});

test("every messenger provider seals exactly as before", () => {
  for (const [id, auth] of Object.entries(MESSENGERS)) {
    for (const fields of [pw, tok, []]) {
      const p: P = { auth };
      expect(`${id}:${sealKindOf(p, fields)}`).toBe(`${id}:${before(p, fields)}`);
    }
  }
  expect(sealKindOf({ auth: MESSENGERS.kakaotalk! }, pw)).toBe("login");
  expect(sealKindOf({ auth: MESSENGERS.slack! }, tok)).toBe("token");
});

test("a card whose service is not listed: a token field means token, else login (as before)", () => {
  expect(sealKindOf(undefined, tok)).toBe("token");
  expect(sealKindOf(undefined, pw)).toBe("login");
  expect(sealKindOf(undefined, [])).toBe("login");
  for (const fields of [tok, pw, []]) expect(sealKindOf(undefined, fields)).toBe(before(undefined, fields));
});

test("the credential card seals with sealKindOf", () => {
  const src = readFileSync(new URL("../src/screens/chat/cards/CredentialCard.tsx", import.meta.url), "utf8");
  expect(src).toMatch(/const kind = sealKindOf\(provider, card\.fields\);/);
  expect(src).not.toMatch(/provider\?\.auth === "token"/);
});
