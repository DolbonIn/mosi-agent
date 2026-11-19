/**
 * Discord / Telegram halves of the login relay routes (Slack's are in slack-login/routes.ts; the shared route
 * handlers dispatch by provider):
 *   POST /api/connections/:provider/login        {keepFor?}                    → LoginRelayResponse
 *   POST /api/connections/:provider/login/step   {relayId[, phone|code|password: sealed]} → LoginRelayResponse
 *                                                 (no secret field = poll)
 *   POST /api/connections/:provider/login/cancel {relayId}                     → {ok:true}
 * Bearer auth only (no cookies, so no CSRF surface), `Content-Type: application/json` required (415), 16 KiB body
 * cap. Secrets arrive as device-sealed envelopes and are opened inside the relay, never here.
 */
import type { EnclaveEnvelope, KeepFor } from "@pickle/protocol";
import type { Core } from "../core.ts";
import { bad, HttpError, json, notFound, readJson, type Ctx } from "../http.ts";
import { isRecord } from "../util.ts";
import { LOGIN_PROVIDERS, type LoginProvider, type MessengerLoginRelay, type StepInput } from "./relay.ts";

const BODY_LIMIT = 16 * 1024;
const KEEP: Set<string> = new Set(["1h", "1d", "7d", "30d", "forever"]);
const RELAY_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function isLoginProvider(p: unknown): p is LoginProvider {
  return typeof p === "string" && (LOGIN_PROVIDERS as readonly string[]).includes(p);
}

function jsonOnly(c: Ctx): void {
  const ct = c.req.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(ct)) throw new HttpError(415, "unsupported_media_type", "JSON으로 보내 주세요");
}

function envelope(v: unknown, field: string): EnclaveEnvelope {
  if (
    !isRecord(v) ||
    v.v !== 1 ||
    v.alg !== "ECDH-P256+HKDF-SHA256+A256GCM" ||
    typeof v.kid !== "string" ||
    !isRecord(v.epk) ||
    typeof v.iv !== "string" ||
    v.iv.length > 64 ||
    typeof v.ct !== "string" ||
    v.ct.length > 4096 ||
    typeof v.aad !== "string"
  ) {
    throw bad(`${field}는 기기에서 암호화해서 보내야 해요`, "invalid_envelope");
  }
  return v as unknown as EnclaveEnvelope;
}

export function messengerLoginRoutes(core: Core, relay: MessengerLoginRelay) {
  const provider = (c: Ctx): LoginProvider => {
    const p = c.params.provider;
    if (!isLoginProvider(p)) throw notFound("이 서비스는 앱 안 로그인을 지원하지 않아요", "login_relay_unsupported");
    return p;
  };
  const answer = (userId: string, p: LoginProvider, res: { state: string; error?: { code: string } }) =>
    core.log.info("messenger_login answer", { user: userId, provider: p, state: res.state, err: res.error?.code });

  return {
    start: async (c: Ctx, userId: string) => {
      const p = provider(c);
      jsonOnly(c);
      const body = await readJson(c.req, BODY_LIMIT);
      if (body.provider !== undefined && body.provider !== p) throw bad("provider가 주소와 달라요", "invalid_provider");
      if (body.email !== undefined || body.phone !== undefined) throw bad("시작할 땐 비밀 값을 보내지 않아요", "invalid_start");
      const keepFor = (body.keepFor === undefined ? "30d" : body.keepFor) as KeepFor;
      if (typeof keepFor !== "string" || !KEEP.has(keepFor)) throw bad("보관 기간이 올바르지 않아요", "invalid_keep_for");
      const res = await relay.start(userId, p, { keepFor });
      answer(userId, p, res);
      return json(res);
    },

    step: async (c: Ctx, userId: string) => {
      const p = provider(c);
      jsonOnly(c);
      const body = await readJson(c.req, BODY_LIMIT);
      if (typeof body.relayId !== "string" || !RELAY_ID_RE.test(body.relayId)) throw bad("relayId가 올바르지 않아요", "invalid_relay");
      const given = (["phone", "code", "password", "totp", "teamId"] as const).filter((k) => body[k] !== undefined);
      if (given.length > 1) throw bad("phone, code, password 중 하나만 보내 주세요", "invalid_step");
      const k = given[0];
      if (k === "totp" || k === "teamId") throw bad("이 서비스에는 없는 단계예요", "invalid_step");
      const label = k === "phone" ? "전화번호" : k === "password" ? "비밀번호" : "코드";
      const input: StepInput = k ? { relayId: body.relayId, kind: k, sealed: envelope(body[k], label) } : { relayId: body.relayId, kind: "poll" };
      const res = await relay.step(userId, input);
      if (input.kind !== "poll") answer(userId, p, res);
      return json(res);
    },

    cancel: async (c: Ctx, userId: string) => {
      provider(c);
      jsonOnly(c);
      const body = await readJson(c.req, BODY_LIMIT);
      if (typeof body.relayId !== "string" || !RELAY_ID_RE.test(body.relayId)) throw bad("relayId가 올바르지 않아요", "invalid_relay");
      await relay.cancel(userId, body.relayId);
      return json({ ok: true });
    },
  };
}
