/**
 * Credential Enclave routes (GET /api/enclave, /api/credentials CRUD, /api/access-log) and
 * messenger + k-skill connections (/api/connections/*; k-skill services in kskill.ts). The server never sees
 * plaintext: clients send device-sealed envelopes that only the enclave can open. Secrets never appear in
 * responses/logs.
 */
import { TOSS_SERVICE } from "./invest/toss.ts";
import type { Card, ConnectRequest, CredentialInfo, KeepFor, SaveCredentialRequest } from "@pickle/protocol";
import { publishMessage, publishThread, type Core } from "./core.ts";
import { bad, HttpError, json, notFound, readJson, type Ctx } from "./http.ts";
import { clampInt, isRecord, safeJson } from "./util.ts";
import { errInfo } from "./log.ts";
import { safeProviders } from "./profile.ts";
import { afterKskillSave, isKskillService, kskillConnectionRows, kskillConnectResponse, kskillDisconnect, kskillProviders, publishKskillState } from "./kskill.ts";

const KINDS = new Set(["login", "card", "token"]);
const KEEP: Set<string> = new Set(["1h", "1d", "7d", "30d", "forever"]);
const SERVICE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export function validateSaveRequest(v: unknown, userId: string): SaveCredentialRequest {
  if (!isRecord(v)) throw bad("저장할 정보가 올바르지 않아요", "invalid_credential");
  const { service, label, kind, hint, keepFor, envelope } = v;
  if (typeof service !== "string" || !SERVICE_RE.test(service)) throw bad("서비스 이름이 올바르지 않아요", "invalid_credential");
  if (typeof label !== "string" || !label.trim() || label.length > 80) throw bad("이름(label)이 올바르지 않아요", "invalid_credential");
  if (typeof kind !== "string" || !KINDS.has(kind)) throw bad("종류(kind)가 올바르지 않아요", "invalid_credential");
  if (typeof hint !== "string" || hint.length > 80) throw bad("힌트(hint)가 올바르지 않아요", "invalid_credential");
  if (typeof keepFor !== "string" || !KEEP.has(keepFor)) throw bad("접근 유지 기간이 올바르지 않아요", "invalid_credential");
  if (!isRecord(envelope)) throw bad("암호화된 정보가 없어요", "invalid_envelope");
  const e = envelope;
  if (
    e.v !== 1 ||
    e.alg !== "ECDH-P256+HKDF-SHA256+A256GCM" ||
    typeof e.kid !== "string" ||
    !isRecord(e.epk) ||
    typeof e.iv !== "string" ||
    typeof e.ct !== "string" ||
    e.ct.length > 16_384 ||
    typeof e.aad !== "string"
  )
    throw bad("암호화된 정보 형식이 올바르지 않아요", "invalid_envelope");
  if (e.aad !== `${userId}:${service}:${kind}`) throw bad("이 계정용으로 암호화된 정보가 아니에요", "invalid_envelope");
  return v as unknown as SaveCredentialRequest;
}

/** Flip pending `credential_request` cards for `service` to "saved" and push the updates. */
export function markCredentialCardsSaved(core: Core, userId: string, service: string): number {
  const touched = new Set<string>();
  let n = 0;
  for (const row of core.db.messagesWithCard(userId, "credential_request")) {
    // in shared threads, only my own agent's requests are mine to resolve
    if (row.author_user_id && row.author_user_id !== userId) continue;
    const cards = safeJson<Card[]>(row.cards_json, []);
    let changed = false;
    const next = cards.map((c) => {
      if (c.type === "credential_request" && c.service === service && c.status === "pending") {
        changed = true;
        return { ...c, status: "saved" as const };
      }
      return c;
    });
    if (!changed) continue;
    core.db.updateMessageCards(row.id, next);
    publishMessage(core, row.id);
    touched.add(row.thread_id);
    n++;
  }
  for (const t of touched) publishThread(core, t);
  return n;
}

/** User-facing message from a package error: keep Korean text, otherwise a generic line. */
function friendly(err: unknown, fallback: string): string {
  const m = err instanceof Error ? err.message : "";
  return /[가-힣]/.test(m) && m.length <= 200 ? m : fallback;
}

const MESSENGER_STATUS: Record<string, number> = {
  unknown_provider: 404,
  chat_not_found: 404,
  credential_not_found: 404,
  not_connected: 409,
  session_expired: 409,
  chat_ambiguous: 409,
  rate_limited: 429,
  network: 502,
  upstream: 502,
  provider_unavailable: 503,
};

/**
 * VaultError / MessengerError carry a stable `code` and a fixed, secret-free Korean message that
 * may be shown as-is. Anything else gets the fallback.
 */
export function packageError(err: unknown, fallback: { status: number; code: string; message: string }): HttpError {
  const e = err as { name?: unknown; code?: unknown };
  if (err instanceof Error && typeof e.code === "string" && (e.name === "VaultError" || e.name === "MessengerError")) {
    const code = e.code;
    if (e.name === "VaultError") {
      if (code.startsWith("envelope_") || code === "invalid_request") return new HttpError(400, "invalid_envelope", err.message);
      if (code === "credential_not_found") return new HttpError(404, code, err.message);
      if (code === "credential_expired") return new HttpError(410, code, err.message);
      return new HttpError(fallback.status, fallback.code, fallback.message);
    }
    // rate_limited carries the provider's Retry-After (seconds), sent on like the server's own 429s
    const retryAfter = (e as { retryAfter?: unknown }).retryAfter;
    const ra = code === "rate_limited" && typeof retryAfter === "number" && retryAfter > 0 ? Math.ceil(retryAfter) : 0;
    return new HttpError(MESSENGER_STATUS[code] ?? 400, code, err.message, ra > 0 ? { "Retry-After": String(ra) } : undefined);
  }
  return new HttpError(fallback.status, fallback.code, friendly(err, fallback.message));
}

/** A k-skill login must be sealed as the kind its catalog entry names (the aad carries the kind). */
function checkKskillKind(core: Core, req: SaveCredentialRequest): void {
  const svc = core.connections.service(req.service);
  if (svc && req.kind !== svc.kind) throw bad("이 서비스의 연결 방식과 맞지 않아요", "invalid_credential");
}

export function credentialRoutes(core: Core) {
  const { deps } = core;
  return {
    enclave: () => json(deps.enclave.info()),

    list: async (_c: Ctx, userId: string) => json(await deps.vault.list(userId)),

    save: async (c: Ctx, userId: string) => {
      const req = validateSaveRequest(await readJson(c.req), userId);
      const kskill = isKskillService(core, req.service) && !safeProviders(core).some((p) => p.id === req.service);
      if (kskill) checkKskillKind(core, req);
      let info;
      try {
        info = await deps.vault.save(userId, req);
      } catch (err) {
        core.log.warn("vault.save failed", { user: userId, service: req.service, err: errInfo(err) });
        throw packageError(err, { status: 500, code: "vault_failed", message: "보안 금고에 저장하지 못했어요. 다시 시도해 주세요." });
      }
      markCredentialCardsSaved(core, userId, req.service);
      // a Toss login that is no catalog service here (a server without the k-skill catalog): one holdings read in the
      // background; a catalog one reads after its check passes (kskill.ts), with the token that check got
      if (req.service === TOSS_SERVICE && !kskill) core.track(core.invest.onTossSaved(userId));
      if (kskill) {
        // a k-skill login saved from the vault screen connects like POST /api/connections/:service
        const r = await afterKskillSave(core, userId, info, { created: true });
        if (r.status === "error") throw new HttpError(400, "connect_failed", r.message);
        await kskillConnectResponse(core, userId, req.service, info, r); // the `connection` event (connected, or checking)
      }
      return json(info, 201);
    },

    patch: async (c: Ctx, userId: string) => {
      const body = await readJson(c.req);
      if (typeof body.keepFor !== "string" || !KEEP.has(body.keepFor)) throw bad("접근 유지 기간이 올바르지 않아요");
      try {
        return json(await deps.vault.renew(userId, c.params.id!, body.keepFor as KeepFor));
      } catch (err) {
        core.log.warn("vault.renew failed", { user: userId, err: errInfo(err) });
        throw packageError(err, { status: 404, code: "credential_not_found", message: "저장된 정보를 찾을 수 없어요" });
      }
    },

    remove: async (c: Ctx, userId: string) => {
      let service: string | null = null;
      {
        try {
          service = (await deps.vault.list(userId)).find((r) => r.id === c.params.id)?.service ?? null;
        } catch {
          service = null;
        }
      }
      if (!(await deps.vault.remove(userId, c.params.id!))) throw notFound("저장된 정보를 찾을 수 없어요");
      // a k-skill login deleted from the vault screen: its cached sessions / tokens go too, and the app hears it
      if (service && isKskillService(core, service)) {
        core.connections.forget(userId, service);
        await publishKskillState(core, userId, service);
      }
      if (service === TOSS_SERVICE) await core.invest.onTossRemoved(userId);
      return json({ ok: true });
    },

    accessLog: async (c: Ctx, userId: string) => json(await deps.vault.accessLog(userId, clampInt(c.url.searchParams.get("limit"), 1, 200, 50))),
  };
}

export function connectionRoutes(core: Core) {
  const { deps } = core;
  const known = (provider: string) => {
    if (!safeProviders(core).some((p) => p.id === provider)) throw notFound("지원하지 않는 서비스예요", "unknown_provider");
  };
  /** a k-skill catalog service (a messenger provider of the same id wins) */
  const kskill = (provider: string) => isKskillService(core, provider) && !safeProviders(core).some((p) => p.id === provider);

  /** POST /api/connections/:service for a k-skill service: save the sealed login (or take a saved one), verify, wake */
  const connectKskill = async (c: Ctx, userId: string, service: string) => {
    const body = await readJson(c.req);
    let info: Pick<CredentialInfo, "id" | "service" | "hint">;
    let created = false;
    if (body.credential !== undefined) {
      const req = validateSaveRequest(body.credential, userId);
      if (req.service !== service) throw bad("연결할 서비스와 저장할 정보가 맞지 않아요", "invalid_credential");
      checkKskillKind(core, req);
      try {
        info = await deps.vault.save(userId, req);
        created = true;
      } catch (err) {
        core.log.warn("vault.save failed", { user: userId, service, err: errInfo(err) });
        throw packageError(err, { status: 500, code: "vault_failed", message: "보안 금고에 저장하지 못했어요. 다시 시도해 주세요." });
      }
    } else if (typeof body.credentialId === "string" && body.credentialId.length <= 80) {
      const row = (await deps.vault.list(userId)).find((r) => r.id === body.credentialId && r.service === service && !r.expired);
      if (!row) throw notFound("저장된 정보를 찾을 수 없어요", "credential_not_found");
      info = row;
    } else throw bad("연결할 정보가 없어요", "invalid_credential");
    const r = await afterKskillSave(core, userId, info, { created });
    return json(await kskillConnectResponse(core, userId, service, info, r));
  };

  return {
    list: async (_c: Ctx, userId: string) => {
      let connections: Awaited<ReturnType<typeof deps.hub.connections>> = [];
      try {
        connections = await deps.hub.connections(userId);
      } catch (err) {
        core.log.warn("hub.connections failed", { err: errInfo(err) });
      }
      const providers = safeProviders(core);
      const ids = new Set(providers.map((p) => p.id));
      const korea = kskillProviders(core).filter((p) => !ids.has(p.id));
      const koreaIds = new Set(korea.map((p) => p.id));
      const rows = korea.length ? (await kskillConnectionRows(core, userId)).filter((r) => koreaIds.has(r.provider)) : [];
      return json({ providers: [...providers, ...korea], connections: [...connections, ...rows] });
    },

    connect: async (c: Ctx, userId: string) => {
      const provider = c.params.provider!;
      if (kskill(provider)) return connectKskill(c, userId, provider);
      known(provider);
      const body = await readJson(c.req);
      const req: ConnectRequest = {};
      if (body.credentialId !== undefined) {
        if (typeof body.credentialId !== "string" || body.credentialId.length > 80) throw bad("credentialId가 올바르지 않아요");
        req.credentialId = body.credentialId;
      }
      if (body.credential !== undefined) req.credential = validateSaveRequest(body.credential, userId);
      // login failures come back as connection.status "error" + Korean lastError (200);
      // only validation problems throw
      try {
        const res = await deps.hub.connect(userId, provider, req);
        if ((req.credential || req.credentialId) && res.connection.status !== "error") markCredentialCardsSaved(core, userId, provider);
        core.log.info("connection", { user: userId, provider, status: res.connection.status });
        return json(res);
      } catch (err) {
        core.log.warn("hub.connect failed", { user: userId, provider, err: errInfo(err) });
        throw packageError(err, { status: 502, code: "connect_failed", message: "연결하지 못했어요. 입력한 정보를 확인하고 다시 시도해 주세요." });
      }
    },

    verify: async (c: Ctx, userId: string) => {
      const provider = c.params.provider!;
      known(provider);
      const body = await readJson(c.req);
      // display_code flows (KakaoTalk, LINE, Teams) poll with an empty code; enter_code sends one
      const code = typeof body.code === "string" ? body.code.trim() : body.code === undefined ? "" : null;
      if (code === null || (code !== "" && !/^[A-Za-z0-9-]{2,16}$/.test(code))) throw bad("인증 코드가 올바르지 않아요", "invalid_code");
      try {
        const res = await deps.hub.verify(userId, provider, code);
        if (res.connection.status === "connected") markCredentialCardsSaved(core, userId, provider);
        return json(res);
      } catch (err) {
        core.log.warn("hub.verify failed", { user: userId, provider, err: errInfo(err) });
        throw packageError(err, { status: 502, code: "verify_failed", message: "인증하지 못했어요. 코드를 확인하고 다시 시도해 주세요." });
      }
    },

    disconnect: async (c: Ctx, userId: string) => {
      const provider = c.params.provider!;
      if (kskill(provider)) {
        try {
          return json({ ok: true, ...(await kskillDisconnect(core, userId, provider)) });
        } catch (err) {
          core.log.warn("connection revoke failed", { user: userId, provider, err: errInfo(err) });
          throw packageError(err, { status: 502, code: "disconnect_failed", message: "연결을 해제하지 못했어요. 다시 시도해 주세요." });
        }
      }
      known(provider);
      await deps.hub.disconnect(userId, provider);
      return json({ ok: true });
    },

    chats: async (c: Ctx, userId: string) => {
      const provider = c.params.provider!;
      known(provider);
      const search = c.url.searchParams.get("search")?.slice(0, 50) || undefined;
      const limit = clampInt(c.url.searchParams.get("limit"), 1, 100, 30);
      try {
        return json(await deps.hub.listChats(userId, provider, { search, limit }));
      } catch (err) {
        core.log.warn("hub.listChats failed", { user: userId, provider, err: errInfo(err) });
        throw packageError(err, { status: 502, code: "chats_failed", message: "대화 목록을 불러오지 못했어요." });
      }
    },
  };
}
