/** 나의 모시: profile summary, quota tickets, settings, agent profile, skills, memories. */
import type { AgentPatch, AvatarSpec, ProfileResponse, SettingsView, Tickets, UserSettings } from "@pickle/protocol";
import { NoSkillsError } from "@pickle/launcher";
import { agentFor, agentStatusOf, quotaFor, settingsOf, settingsView, userPublic, type Core } from "./core.ts";
import { bad, json, notFound, readJson, type Ctx } from "./http.ts";
import { lastQuotaDays, quotaDay } from "./kst.ts";
import { mergeSettings, SettingsError } from "./settings.ts";
import { isRecord } from "./util.ts";
import { errInfo } from "./log.ts";
import { profilePhone } from "./myphone.ts";
import { skillsConfiguredFor } from "./kskill.ts";

const SHAPES = new Set(["blob", "round", "drop"]);
const EYES = new Set(["dot", "oval", "smile"]);

/**
 * PATCH /api/agent body → AgentPatch. Only the fields sent (a partial avatar, per-skill `skills` toggles; an older app's
 * whole `enabledSkills` list still works, but not together with `skills`). The merge itself happens in the launcher's
 * per-user queue (launcher.update), where "at least one skill on" is checked on the merged list. Anything else (`rev`
 * too: only the server makes it) is refused.
 */
export function validateAgentPatch(body: Record<string, unknown>, knownSkills: Set<string> | null): AgentPatch {
  const patch: AgentPatch = {};
  for (const k of Object.keys(body)) if (!["name", "persona", "avatar", "skills", "enabledSkills"].includes(k)) throw bad(`알 수 없는 항목이에요: ${k}`);
  if (body.skills !== undefined && body.enabledSkills !== undefined) throw bad("스킬 목록이 올바르지 않아요");
  if (body.name !== undefined) {
    if (typeof body.name !== "string") throw bad("이름이 올바르지 않아요");
    const name = body.name.trim();
    if (name.length < 1 || name.length > 12 || /[\u0000-\u001f<>]/.test(name)) throw bad("모시 이름은 1~12자로 지어 주세요");
    patch.name = name;
  }
  if (body.persona !== undefined) {
    if (typeof body.persona !== "string" || body.persona.length > 2000) throw bad("성격 설명은 2000자까지 쓸 수 있어요");
    patch.persona = body.persona;
  }
  if (body.avatar !== undefined) {
    const a = body.avatar;
    const keys = isRecord(a) ? Object.keys(a) : [];
    if (
      !isRecord(a) ||
      !keys.length ||
      keys.some((k) => k !== "hue" && k !== "shape" && k !== "eyes") ||
      (a.hue !== undefined && (typeof a.hue !== "number" || !(a.hue >= 0 && a.hue <= 360))) ||
      (a.shape !== undefined && !SHAPES.has(String(a.shape))) ||
      (a.eyes !== undefined && !EYES.has(String(a.eyes)))
    )
      throw bad("아바타 설정이 올바르지 않아요");
    const avatar: Partial<AvatarSpec> = {};
    if (a.hue !== undefined) avatar.hue = Math.round(a.hue as number);
    if (a.shape !== undefined) avatar.shape = a.shape as AvatarSpec["shape"];
    if (a.eyes !== undefined) avatar.eyes = a.eyes as AvatarSpec["eyes"];
    patch.avatar = avatar;
  }
  if (body.skills !== undefined) {
    const s = body.skills;
    const entries = isRecord(s) ? Object.entries(s) : [];
    if (!isRecord(s) || !entries.length || entries.length > 100 || entries.some(([, on]) => typeof on !== "boolean")) throw bad("스킬 목록이 올바르지 않아요");
    if (knownSkills) {
      const unknown = entries.map(([id]) => id).filter((id) => !knownSkills.has(id));
      if (unknown.length) throw bad(`알 수 없는 스킬이에요: ${unknown.slice(0, 3).join(", ")}`);
    }
    patch.skills = Object.fromEntries(entries) as Record<string, boolean>;
  }
  if (body.enabledSkills !== undefined) {
    if (!Array.isArray(body.enabledSkills) || body.enabledSkills.length > 100 || body.enabledSkills.some((s) => typeof s !== "string"))
      throw bad("스킬 목록이 올바르지 않아요");
    const list = [...new Set(body.enabledSkills as string[])];
    // an empty list would read as "no selection" (= all skills) downstream; refuse the ambiguity
    if (!list.length) throw bad("기능을 하나 이상 켜 두어야 해요", "no_skills");
    if (knownSkills) {
      const unknown = list.filter((s) => !knownSkills.has(s));
      if (unknown.length) throw bad(`알 수 없는 스킬이에요: ${unknown.slice(0, 3).join(", ")}`);
    }
    patch.enabledSkills = list;
  }
  return patch;
}

export function profileRoutes(core: Core) {
  const { db, deps } = core;

  const providerIcons = () => new Map(safeProviders(core).map((p) => [p.id, p.icon as string]));

  return {
    profile: async (_c: Ctx, userId: string) => {
      const user = db.userById(userId)!;
      const days = lastQuotaDays(core.now(), 7);
      const usage = db.usageDays(userId, days);
      let connections: { provider: string; status: string }[] = [];
      try {
        connections = await deps.hub.connections(userId);
      } catch (err) {
        core.log.warn("hub.connections failed", { err: errInfo(err) });
      }
      const connected = connections.filter((c) => c.status === "connected");
      const icons = providerIcons();
      let memories: ProfileResponse["memories"] = [];
      try {
        memories = await deps.launcher.listMemories(userId);
      } catch {
        memories = [];
      }
      const counts = db.credentialCounts(userId);
      const res: ProfileResponse = {
        user: userPublic(user),
        agent: await agentFor(core, user),
        quota: quotaFor(core, userId),
        tickets: db.tickets(userId),
        usage7d: days.map((d) => ({ day: d.slice(5), tokens: usage.get(d) ?? 0 })),
        connections: { connected: connected.length, total: safeProviders(core).length, icons: connected.map((c) => icons.get(c.provider) ?? c.provider) },
        paymentMethods: counts.card,
        savedLogins: counts.login,
        settings: settingsView(user),
        phone: profilePhone(core, userId),
        memories,
      };
      return json(res);
    },

    useTicket: async (c: Ctx, userId: string) => {
      const body = await readJson(c.req);
      const kind = body.kind ?? "basic";
      if (kind !== "basic" && kind !== "premium") throw bad("티켓 종류가 올바르지 않아요", "invalid_ticket");
      const day = quotaDay(core.now());
      if (db.usage(userId, day).counted <= 0) throw bad("아직 초기화할 사용량이 없어요", "nothing_to_reset");
      const ok = db.tx(() => {
        if (!db.useTicket(userId, kind)) return false;
        db.resetCounted(userId, day);
        return true;
      });
      if (!ok) throw bad("남은 티켓이 없어요", "no_tickets");
      const quota = quotaFor(core, userId);
      const tickets: Tickets = db.tickets(userId);
      core.events.publish(userId, { type: "quota", quota });
      core.log.info("ticket used", { user: userId, kind });
      return json({ quota, tickets });
    },

    // read, merge and write with no await in between, so two PATCHes never interleave; a value that moved raises the
    // revision in the same UPDATE and goes to every device of the person (the sender's too, beside this answer). An
    // unchanged result stores nothing and sends nothing, so a device echoing a received value back ends the echo here.
    patchSettings: async (c: Ctx, userId: string) => {
      const body = await readJson(c.req);
      const user = db.userById(userId)!;
      let next: UserSettings;
      try {
        next = mergeSettings(settingsOf(user), body);
      } catch (err) {
        if (err instanceof SettingsError) throw bad(err.message, "invalid_settings");
        throw err;
      }
      const json_ = JSON.stringify(next);
      if (json_ === JSON.stringify(settingsOf(user))) return json(settingsView(user));
      const view: SettingsView = { ...next, rev: db.setUserSettings(userId, json_, core.now()) };
      core.events.publish(userId, { type: "settings", settings: view });
      return json(view);
    },

    getAgent: async (_c: Ctx, userId: string) => json(await agentFor(core, db.userById(userId)!)),

    patchAgent: async (c: Ctx, userId: string) => {
      const body = await readJson(c.req);
      let known: Set<string> | null = null;
      try {
        known = new Set(deps.skills.listSkills().map((s) => s.id));
      } catch {
        known = null;
      }
      const patch = validateAgentPatch(body, known);
      let res: Awaited<ReturnType<typeof deps.launcher.update>>;
      try {
        res = await deps.launcher.update(userId, patch, { allSkills: known ? [...known] : [] });
      } catch (err) {
        if (err instanceof NoSkillsError) throw bad("기능을 하나 이상 켜 두어야 해요", "no_skills");
        throw err;
      }
      // the profile as the merge left it, values and rev from the same write: the answer and the event are one object, and
      // no second read can fall back to the defaults
      const agent = { ...res.profile, status: agentStatusOf(core, userId) };
      if (!res.changed) return json(agent);
      if (patch.name) db.setAgentName(userId, patch.name);
      // the whole profile with its new rev, to every device of the person (this one too, beside the answer)
      core.events.publish(userId, { type: "agent", agent });
      return json(agent);
    },

    restartAgent: async (_c: Ctx, userId: string) => {
      await deps.launcher.restart(userId);
      core.events.publish(userId, { type: "agent_status", status: "idle", text: "다시 시작했어요" });
      return json(await agentFor(core, db.userById(userId)!));
    },

    skills: async (_c: Ctx, userId: string) => {
      let rows: ReturnType<typeof deps.skills.listSkills>;
      try {
        rows = deps.skills.listSkills();
      } catch (err) {
        core.log.warn("listSkills failed", { err: errInfo(err) });
        return json([]);
      }
      // k-skill login tools: configured = this owner connected the service
      return json(await skillsConfiguredFor(core, userId, rows));
    },

    memories: async (_c: Ctx, userId: string) => json(await deps.launcher.listMemories(userId)),

    forget: async (c: Ctx, userId: string) => {
      if (!(await deps.launcher.forget(userId, c.params.id!))) throw notFound("기억을 찾을 수 없어요");
      return json({ ok: true });
    },
  };
}

export function safeProviders(core: Core) {
  try {
    return core.deps.providers();
  } catch {
    return [];
  }
}
