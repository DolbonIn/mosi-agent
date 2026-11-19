/**
 * POST /api/connections/:provider/login        LoginRelayStartRequest → LoginRelayResponse
 * POST /api/connections/:provider/login/step   LoginRelayStepRequest  → LoginRelayResponse
 * POST /api/connections/:provider/login/cancel {relayId}              → {ok:true}
 *
 * Bearer auth only (no cookies, so no CSRF surface), `Content-Type: application/json` required (415 otherwise),
 * 16 KiB body cap. Secrets arrive as device-sealed envelopes and are opened inside the relay, never here.
 */
import type { EnclaveEnvelope, KeepFor } from "@pickle/protocol";
import type { Core } from "../core.ts";
import { bad, HttpError, json, notFound, readJson, type Ctx } from "../http.ts";
import { isRecord } from "../util.ts";
import { normalizeWorkspace, type SlackLoginRelay, type StepInput } from "./relay.ts";

const BODY_LIMIT = 16 * 1024;
const KEEP: Set<string> = new Set(["1h", "1d", "7d", "30d", "forever"]);
const RELAY_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TEAM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

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
    typeof v.ct !== "string" ||
    v.ct.length > 4096 ||
    typeof v.aad !== "string"
  ) {
    throw bad(`${field}는 기기에서 암호화해서 보내야 해요`, "invalid_envelope");
  }
  return v as unknown as EnclaveEnvelope;
}

export function loginRelayRoutes(core: Core, relay: SlackLoginRelay) {
  const slackOnly = (c: Ctx) => {
    const p = c.params.provider;
    if (p !== "slack") throw notFound("이 서비스는 앱 안 로그인을 지원하지 않아요", "login_relay_unsupported");
  };

  return {
    start: async (c: Ctx, userId: string) => {
      slackOnly(c);
      jsonOnly(c);
      const body = await readJson(c.req, BODY_LIMIT);
      if (body.provider !== undefined && body.provider !== "slack") throw bad("provider가 주소와 달라요", "invalid_provider");
      const method = body.method === undefined ? "code" : body.method;
      if (method !== "code" && method !== "password") throw bad("로그인 방법이 올바르지 않아요", "invalid_method");
      const keepFor = (body.keepFor === undefined ? "30d" : body.keepFor) as KeepFor;
      if (typeof keepFor !== "string" || !KEEP.has(keepFor)) throw bad("보관 기간이 올바르지 않아요", "invalid_keep_for");
      const workspace = normalizeWorkspace(body.workspace);
      const email = envelope(body.email, "이메일");
      const res = await relay.start(userId, { workspace, method, email, keepFor });
      core.log.info("slack_login answer", { user: userId, state: res.state, err: res.error?.code });
      return json(res);
    },

    step: async (c: Ctx, userId: string) => {
      slackOnly(c);
      jsonOnly(c);
      const body = await readJson(c.req, BODY_LIMIT);
      if (typeof body.relayId !== "string" || !RELAY_ID_RE.test(body.relayId)) throw bad("relayId가 올바르지 않아요", "invalid_relay");
      const given = (["code", "password", "totp", "teamId"] as const).filter((k) => body[k] !== undefined);
      if (given.length !== 1) throw bad("code, password, totp, teamId 중 하나만 보내 주세요", "invalid_step");
      const k = given[0]!;
      let input: StepInput;
      if (k === "teamId") {
        if (typeof body.teamId !== "string" || !TEAM_ID_RE.test(body.teamId)) throw bad("워크스페이스 선택이 올바르지 않아요", "invalid_team");
        input = { relayId: body.relayId, kind: "team", teamId: body.teamId };
      } else {
        input = { relayId: body.relayId, kind: k, sealed: envelope(body[k], k === "password" ? "비밀번호" : "코드") };
      }
      const res = await relay.step(userId, input);
      core.log.info("slack_login answer", { user: userId, state: res.state, err: res.error?.code });
      return json(res);
    },

    cancel: async (c: Ctx, userId: string) => {
      slackOnly(c);
      jsonOnly(c);
      const body = await readJson(c.req, BODY_LIMIT);
      if (typeof body.relayId !== "string" || !RELAY_ID_RE.test(body.relayId)) throw bad("relayId가 올바르지 않아요", "invalid_relay");
      await relay.cancel(userId, body.relayId);
      return json({ ok: true });
    },
  };
}
