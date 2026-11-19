// The vault kind the connections screen's sheets seal as (providerCopy.sealKind, used by ConnectSheet), and the row label
// for an API-key service. Since 8d8b535 the k-skill services come as `auth: "api_key"` with `kind: "token"`
// (docs/architecture/KSKILL-CONNECTIONS.md). ConnectSheet sealed every non-"token" auth as "login", so those saves had the
// wrong aad and the server refused them. The messenger logins must seal exactly as they did before.
import { expect, test } from "bun:test";
import type { ProviderInfo } from "@pickle/protocol";
import { loginCopy, sealKind } from "../src/screens/more/connections/providerCopy";

type P = Pick<ProviderInfo, "auth" | "kind">;
// packages/messengers/src/providers.ts: id → auth (the messenger catalog sends no `kind`)
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
// ConnectSheet's formula before the fix
const before = (p: P) => (p.auth === "token" ? "token" : "login");

test("a k-skill API-key service seals as token, with or without its kind", () => {
  expect(sealKind({ auth: "api_key", kind: "token" })).toBe("token");
  expect(sealKind({ auth: "api_key" })).toBe("token");
  expect(before({ auth: "api_key", kind: "token" })).toBe("login"); // the bug
});

test("the provider's kind wins over its auth", () => {
  expect(sealKind({ auth: "credentials", kind: "login" })).toBe("login");
  expect(sealKind({ auth: "credentials", kind: "token" })).toBe("token");
  expect(sealKind({ auth: "token", kind: "login" })).toBe("login");
});

test("every messenger login seals exactly as before", () => {
  for (const [id, auth] of Object.entries(MESSENGERS)) {
    expect([id, sealKind({ auth })]).toEqual([id, before({ auth })]);
  }
});

test("an API-key service is labelled API 키로 연결; the other labels are unchanged", () => {
  const base = { id: "x", name: "x", category: "korea", icon: "key", hue: 0, fields: [], description: "", capabilities: [], available: true } as unknown as ProviderInfo;
  expect(loginCopy({ ...base, auth: "api_key" })).toBe("API 키로 연결");
  expect(loginCopy({ ...base, auth: "token" })).toBe("토큰으로 연결");
  expect(loginCopy({ ...base, auth: "oauth" })).toBe("회사 계정으로 로그인");
  expect(loginCopy({ ...base, auth: "credentials" })).toBe("계정으로 로그인");
});
