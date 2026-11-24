/**
 * AgentLauncher — per-user agent provisioning (gajae-launcher concepts): one owner-keyed workspace per
 * user, launcher-owned config keys merged on every provision while user-owned keys survive, persona
 * files seeded once and re-read by mtime, append-only markdown memory with BM25 recall, a per-user FIFO
 * turn mutex with steering, and a reconcile pass that repairs but never deletes.
 */
import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { formatKst, kstClock, kstDateKey, looksSecret, scrubSecrets } from "@pickle/agent";
import type { AgentPatch, AgentProfile, AgentStatus, AvatarSpec } from "@pickle/protocol";
import { bm25Search, type Bm25Doc } from "./bm25";
import { MtimeCache, atomicWrite, exists, readText } from "./fsutil";
import { LeaseManager, type Lease } from "./lease";
import { FACTS_HEADER, NOTEPAD_SEED, SAFETY_NOTICES, SAFETY_VERSION, agentsMd, defaultPersona, soulMd, userMdSeed } from "./templates";

export interface LauncherOptions {
  rootDir: string;
  model: string;
  safetyVersion?: number;
}

export interface WorkspaceConfig {
  schemaVersion: 1;
  /** user-owned: survive every re-provision */
  user: { name: string; persona: string; avatar: AvatarSpec; enabledSkills: string[] };
  /** launcher-owned: overwritten on every provision */
  launcher: {
    model: string;
    safetyVersion: number;
    createdAt: number;
    displayName: string;
    lastActiveAt: number | null;
    /** created by reconcile() without real init data; the next provision() fills the user section */
    placeholder?: boolean;
  };
  /**
   * Revision of the user section (AgentProfile.rev), raised whenever update() or provision() changes a value there to
   * nextRev(): max(previous + 1, clock ms). Never down: not after a restart with an earlier clock (+1), nor when the
   * config is put back from a backup or made anew after a corrupt one (the clock). Absent in configs written before
   * revisions (read as 0).
   */
  rev?: number;
}

/** The next revision after `prev`: max(prev + 1, now in ms) (WorkspaceConfig.rev). */
export function nextRev(prev: number | undefined, now = Date.now()): number {
  return Math.max((prev ?? 0) + 1, Math.floor(now));
}

/** The user-owned profile fields AgentPatch changes. */
export type AgentFields = WorkspaceConfig["user"];

/** update() refused a `skills` patch that would leave no skill on (the server answers 400 no_skills). */
export class NoSkillsError extends Error {
  readonly code = "no_skills";
  constructor() {
    super("at least one skill must stay on");
    this.name = "NoSkillsError";
  }
}

export interface SystemPromptContext {
  displayName: string;
  now: Date;
  mode: "text" | "voice";
  connections: string[];
  skills: string[];
  recalled: string[];
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_CAP = 500;
const MEMORY_BOOTSTRAP_BYTES = 8 * 1024;
const NOTEPAD_CAP = 20 * 1024;
const PERSONA_CAP = 2000;
const FILE_PROMPT_CAP = 4000;
const DAILY_RECALL_DAYS = 7;
const FACT_LINE = /^-\s+(.*?)\s*<!--\s*id:([A-Za-z0-9_-]+)\s+at:(\d+)\s*-->\s*$/;
const AVATAR_SHAPES: AvatarSpec["shape"][] = ["blob", "round", "drop"];
const AVATAR_EYES: AvatarSpec["eyes"][] = ["dot", "oval", "smile"];

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new Error("invalid userId");
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function defaultAvatar(userId: string): AvatarSpec {
  return { hue: hash32(userId) % 360, shape: "blob", eyes: "dot" };
}

function validAvatar(a: unknown): AvatarSpec | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const hue = Number(o.hue);
  if (!Number.isFinite(hue) || hue < 0 || hue > 360) return null;
  if (!AVATAR_SHAPES.includes(o.shape as AvatarSpec["shape"]) || !AVATAR_EYES.includes(o.eyes as AvatarSpec["eyes"])) return null;
  return { hue: Math.round(hue), shape: o.shape as AvatarSpec["shape"], eyes: o.eyes as AvatarSpec["eyes"] };
}

function cleanSkills(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.filter((s): s is string => typeof s === "string").map((s) => s.trim().slice(0, 64)).filter(Boolean))].slice(0, 64);
}

/**
 * `patch` merged into `cur` (AgentLauncher.update runs it inside the per-user queue, so concurrent patches never mix):
 * name / persona as sent, the avatar parts sent over the current avatar, `skills` toggles over the current list (an
 * empty list means "every skill" downstream, so it is first spread to `allSkills`), or an older app's whole
 * `enabledSkills` list. Throws on invalid input, and NoSkillsError when `skills` leaves nothing on. Never mutates `cur`.
 */
export function applyAgentPatch(cur: AgentFields, patch: AgentPatch, allSkills: readonly string[] = []): AgentFields {
  const next: AgentFields = { ...cur, avatar: { ...cur.avatar }, enabledSkills: [...cur.enabledSkills] };
  if (patch.skills !== undefined && patch.enabledSkills !== undefined) throw new Error("send skills or enabledSkills, not both");
  if (patch.name !== undefined) {
    const name = oneLine(String(patch.name), 20);
    if (!name) throw new Error("name must not be empty");
    next.name = name;
  }
  if (patch.persona !== undefined) {
    const persona = String(patch.persona).trim();
    if (persona.length > PERSONA_CAP) throw new Error(`persona must be ≤ ${PERSONA_CAP} characters`);
    next.persona = persona || defaultPersona(next.name);
  }
  if (patch.avatar !== undefined) {
    const a = patch.avatar && typeof patch.avatar === "object" ? validAvatar({ ...cur.avatar, ...patch.avatar }) : null;
    if (!a) throw new Error("invalid avatar");
    next.avatar = a;
  }
  if (patch.enabledSkills !== undefined) {
    const s = cleanSkills(patch.enabledSkills);
    if (!s) throw new Error("enabledSkills must be a string array");
    next.enabledSkills = s;
  }
  if (patch.skills !== undefined) {
    if (!patch.skills || typeof patch.skills !== "object" || Array.isArray(patch.skills)) throw new Error("skills must be an object");
    const list = next.enabledSkills.length ? next.enabledSkills : [...allSkills];
    for (const [id, on] of Object.entries(patch.skills)) {
      if (typeof on !== "boolean") throw new Error("skills values must be booleans");
      const i = list.indexOf(id);
      if (on && i < 0) list.push(id);
      if (!on && i >= 0) list.splice(i, 1);
    }
    const s = cleanSkills(list) ?? [];
    if (!s.length) throw new NoSkillsError();
    next.enabledSkills = s;
  }
  return next;
}

/** Whether two profiles' user-owned fields hold the same values (field by field, list order included). */
export function sameAgentFields(a: AgentFields, b: AgentFields): boolean {
  return (
    a.name === b.name &&
    a.persona === b.persona &&
    a.avatar.hue === b.avatar.hue &&
    a.avatar.shape === b.avatar.shape &&
    a.avatar.eyes === b.avatar.eyes &&
    a.enabledSkills.length === b.enabledSkills.length &&
    a.enabledSkills.every((s, i) => s === b.enabledSkills[i])
  );
}

/** "깽이" → "깽이라고", "보람" → "보람이라고" (non-Hangul last letter → "라고"). */
const raGo = (name: string): string => {
  const c = name.charCodeAt(name.length - 1);
  const batchim = c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
  return name + (batchim ? "이라고" : "라고");
};

const oneLine = (s: string, cap: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
};

function capBytes(lines: string[], maxBytes: number): string[] {
  const enc = new TextEncoder();
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const n = enc.encode(l).length + 1;
    if (used + n > maxBytes) break;
    out.push(l);
    used += n;
  }
  return out;
}

function capText(s: string, maxChars: number): string {
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n…(이하 생략)` : s;
}

interface Fact {
  id: string;
  text: string;
  createdAt: number;
}

export class AgentLauncher {
  readonly rootDir: string;
  readonly model: string;
  readonly safetyVersion: number;
  #cache = new MtimeCache();
  #queues = new Map<string, Promise<unknown>>();
  #status = new Map<string, { status: AgentStatus; since: number }>();
  #leases: LeaseManager;

  constructor(opts: LauncherOptions) {
    this.rootDir = opts.rootDir;
    this.model = opts.model;
    this.safetyVersion = opts.safetyVersion ?? SAFETY_VERSION;
    this.#leases = new LeaseManager({
      onAcquire: (u) => this.setStatus(u, "running"),
      onRelease: (u) => {
        if (this.status(u) === "running") this.setStatus(u, "idle");
        void this.#touch(u);
      },
    });
  }

  // ───────────── paths & serialisation ─────────────

  workspaceDir(userId: string): string {
    assertUserId(userId);
    return join(this.rootDir, userId);
  }

  #p(userId: string, ...parts: string[]): string {
    return join(this.workspaceDir(userId), ...parts);
  }

  /** Serialise read-modify-write operations per user (config, facts, daily, notepad). */
  #serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(userId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.#queues.set(userId, tail);
    void tail.then(() => {
      if (this.#queues.get(userId) === tail) this.#queues.delete(userId);
    });
    return run;
  }

  async #readConfig(userId: string): Promise<WorkspaceConfig | null> {
    const raw = await readText(this.#p(userId, "config.json"));
    if (raw === null) return null;
    try {
      const c = JSON.parse(raw) as WorkspaceConfig;
      if (!c || typeof c !== "object" || !c.user || !c.launcher) throw new Error("bad shape");
      return c;
    } catch {
      throw new CorruptConfigError(userId);
    }
  }

  async #writeConfig(userId: string, c: WorkspaceConfig): Promise<void> {
    await atomicWrite(this.#p(userId, "config.json"), `${JSON.stringify(c, null, 2)}\n`);
  }

  #toProfile(userId: string, c: WorkspaceConfig): AgentProfile {
    return {
      id: userId,
      name: c.user.name,
      persona: c.user.persona,
      avatar: c.user.avatar,
      model: c.launcher.model,
      status: this.status(userId),
      enabledSkills: [...c.user.enabledSkills],
      createdAt: c.launcher.createdAt,
      lastActiveAt: c.launcher.lastActiveAt ?? null,
      rev: c.rev ?? 0,
    };
  }

  /** Make sure every workspace file exists; returns the names that had to be (re)created. */
  async #ensureFiles(userId: string, c: WorkspaceConfig, rewriteAgents: boolean): Promise<string[]> {
    const fixed: string[] = [];
    const seed = async (rel: string, text: string, force = false) => {
      const path = this.#p(userId, rel);
      if (force || !(await exists(path))) {
        await atomicWrite(path, text);
        fixed.push(rel);
      }
    };
    await seed("SOUL.md", soulMd(c.user.persona));
    await seed("USER.md", userMdSeed(c.launcher.displayName));
    const agents = await readText(this.#p(userId, "AGENTS.md"));
    const stale = agents !== null && !agents.includes(`pickle:agents v${this.safetyVersion} `);
    await seed("AGENTS.md", agentsMd(this.safetyVersion), rewriteAgents || stale);
    await seed(join("memory", "facts.md"), FACTS_HEADER);
    await seed("notepad.md", NOTEPAD_SEED);
    if (!(await exists(this.#p(userId, "memory", "daily")))) {
      await atomicWrite(this.#p(userId, "memory", "daily", ".keep"), "");
      fixed.push("memory/daily");
    }
    return fixed;
  }

  #freshConfig(userId: string, init: { agentName: string; displayName: string; persona?: string; avatar?: AvatarSpec; enabledSkills?: string[] }, placeholder: boolean): WorkspaceConfig {
    const name = oneLine(init.agentName || "모시", 20) || "모시";
    return {
      schemaVersion: 1,
      user: {
        name,
        persona: (init.persona?.trim() || defaultPersona(name)).slice(0, PERSONA_CAP),
        avatar: validAvatar(init.avatar) ?? defaultAvatar(userId),
        enabledSkills: cleanSkills(init.enabledSkills) ?? [],
      },
      launcher: {
        model: this.model,
        safetyVersion: this.safetyVersion,
        createdAt: Date.now(),
        displayName: oneLine(init.displayName || "사용자", 30) || "사용자",
        lastActiveAt: null,
        ...(placeholder ? { placeholder: true } : {}),
      },
      rev: nextRev(0),
    };
  }

  // ───────────── provisioning ─────────────

  /** Idempotent: creates the workspace, or merges launcher-owned keys into an existing one. */
  async provision(
    userId: string,
    init: { agentName: string; displayName: string; persona?: string; avatar?: AvatarSpec; enabledSkills?: string[] },
  ): Promise<AgentProfile> {
    assertUserId(userId);
    return this.#serial(userId, async () => {
      let existing: WorkspaceConfig | null;
      try {
        existing = await this.#readConfig(userId);
      } catch (err) {
        if (!(err instanceof CorruptConfigError)) throw err;
        await this.#quarantine(userId);
        existing = null;
      }
      let c: WorkspaceConfig;
      let rewriteAgents = false;
      if (!existing || existing.launcher.placeholder) {
        c = this.#freshConfig(userId, init, false);
        if (existing) c.launcher.createdAt = existing.launcher.createdAt;
        if (existing) c.rev = Math.max(c.rev ?? 0, nextRev(existing.rev));
        if (existing) {
          // reconcile seeded files from placeholder data; replace them with the real persona/owner
          await atomicWrite(this.#p(userId, "SOUL.md"), soulMd(c.user.persona));
          await atomicWrite(this.#p(userId, "USER.md"), userMdSeed(c.launcher.displayName));
        }
        rewriteAgents = !!existing && existing.launcher.safetyVersion !== this.safetyVersion;
      } else {
        const u = existing.user;
        c = {
          schemaVersion: 1,
          user: {
            name: typeof u.name === "string" && u.name.trim() ? u.name : oneLine(init.agentName, 20),
            persona: typeof u.persona === "string" ? u.persona : (init.persona ?? defaultPersona(init.agentName)),
            avatar: validAvatar(u.avatar) ?? validAvatar(init.avatar) ?? defaultAvatar(userId),
            enabledSkills: cleanSkills(u.enabledSkills) ?? cleanSkills(init.enabledSkills) ?? [],
          },
          launcher: {
            model: this.model,
            safetyVersion: this.safetyVersion,
            createdAt: existing.launcher.createdAt || Date.now(),
            displayName: oneLine(init.displayName || existing.launcher.displayName || "사용자", 30),
            lastActiveAt: existing.launcher.lastActiveAt ?? null,
          },
          rev: existing.rev ?? 0,
        };
        // a value repaired from init data (an emptied name, a broken avatar) is a change the devices must hear of
        const was = existing.user;
        const same =
          was && Array.isArray(was.enabledSkills) && was.avatar && typeof was.avatar === "object" && sameAgentFields(was, c.user);
        if (!same) c.rev = nextRev(c.rev);
        rewriteAgents = existing.launcher.safetyVersion !== this.safetyVersion;
      }
      await this.#writeConfig(userId, c);
      await this.#ensureFiles(userId, c, rewriteAgents);
      return this.#toProfile(userId, c);
    });
  }

  async profile(userId: string): Promise<AgentProfile | null> {
    assertUserId(userId);
    try {
      const c = await this.#readConfig(userId);
      return c ? this.#toProfile(userId, c) : null;
    } catch (err) {
      if (err instanceof CorruptConfigError) return null;
      throw err;
    }
  }

  /**
   * Merge `patch` into the profile (applyAgentPatch) inside the per-user queue: a read-modify-write that never mixes
   * with another patch. `changed` = a value moved; only then is the config written and its rev raised. `allSkills`:
   * the catalog an empty skill list stands for (spread before `skills` toggles apply).
   */
  async update(userId: string, patch: AgentPatch, opts: { allSkills?: readonly string[] } = {}): Promise<{ profile: AgentProfile; changed: boolean }> {
    assertUserId(userId);
    return this.#serial(userId, async () => {
      const c = await this.#readConfig(userId);
      if (!c) throw new Error("agent not provisioned");
      const next = applyAgentPatch(c.user, patch, opts.allSkills);
      const changed = !sameAgentFields(c.user, next);
      if (patch.persona !== undefined) {
        // SOUL.md follows the persona the person saved, even when the config already held it (a hand-edited file)
        const soul = soulMd(next.persona);
        if ((await readText(this.#p(userId, "SOUL.md"))) !== soul) await atomicWrite(this.#p(userId, "SOUL.md"), soul);
      }
      if (changed || c.launcher.placeholder) {
        if (changed) {
          c.user = next;
          c.rev = nextRev(c.rev);
        }
        delete c.launcher.placeholder;
        await this.#writeConfig(userId, c);
      }
      return { profile: this.#toProfile(userId, c), changed };
    });
  }

  async #quarantine(userId: string): Promise<void> {
    const path = this.#p(userId, "config.json");
    await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
    console.warn(`[pickle/launcher] config.json for ${userId} was unreadable; kept it as config.json.corrupt-*`);
  }

  // ───────────── prompt ─────────────

  async systemPrompt(userId: string, ctx: SystemPromptContext): Promise<string> {
    assertUserId(userId);
    const c = await this.#readConfig(userId).catch(() => null);
    const name = c?.user.name ?? "모시";
    const displayName = oneLine(ctx.displayName || c?.launcher.displayName || "사용자", 30);
    const [soul, userMd, agents, notepad] = await Promise.all([
      this.#cache.read(this.#p(userId, "SOUL.md")),
      this.#cache.read(this.#p(userId, "USER.md")),
      this.#cache.read(this.#p(userId, "AGENTS.md")),
      this.#cache.read(this.#p(userId, "notepad.md")),
    ]);
    const parts: string[] = [];
    parts.push(
      `당신은 모시 앱에서 ${displayName}님을 돕는 개인 AI 에이전트 "${name}"입니다. ${displayName}님을 "${displayName}님"이라고 부르고, 스스로를 ${raGo(name)} 소개하세요.`,
    );
    // file sections: drop HTML comments and the file's own top heading, then use a fixed heading
    const section = (heading: string, body: string, cap: number) => {
      const b = body.replace(/<!--[\s\S]*?-->/g, "").trim().replace(/^#\s+[^\n]*\n?/, "").trim();
      return b ? `${heading}\n${capText(b, cap)}` : "";
    };
    parts.push(section("# 페르소나", soul ?? soulMd(c?.user.persona ?? defaultPersona(name)), FILE_PROMPT_CAP));
    parts.push(section(`# ${displayName}님에 대해`, userMd ?? userMdSeed(displayName), FILE_PROMPT_CAP));
    parts.push(section("# 일하는 방식", agents ?? agentsMd(this.safetyVersion), 12_000));

    // Stable sections first, per-turn sections last: the provider caches the longest unchanged
    // prompt prefix (tools + everything above "# 지금"), which cuts cost and first-token latency.
    const skills = ctx.skills.map((s) => s.trim()).filter(Boolean);
    if (skills.length) parts.push(`# 쓸 수 있는 스킬\n${capText(skills.join("\n"), 6000)}`);

    const now: string[] = [`# 지금`, `- 현재 시각: ${formatKst(ctx.now)} (한국 표준시)`];
    now.push(
      ctx.mode === "voice"
        ? "- 대화 방식: 음성 통화 — 한두 문장의 짧은 구어체로만 답하세요. 목록, 마크다운, 이모지, URL은 쓰지 마세요."
        : "- 대화 방식: 텍스트 채팅",
    );
    const conns = ctx.connections.map((s) => oneLine(s, 40)).filter(Boolean);
    now.push(`- 연결된 서비스: ${conns.length ? conns.join(", ") : "아직 없음 (프로필 > 연결에서 추가할 수 있어요)"}`);
    parts.push(now.join("\n"));

    const recalled = capBytes(
      ctx.recalled.map((m) => `- ${oneLine(m, 400)}`).filter((l) => l.length > 2),
      MEMORY_BOOTSTRAP_BYTES,
    );
    if (recalled.length) parts.push(`# 기억하고 있는 것 (참고용 · 오래됐거나 틀릴 수 있어요)\n${recalled.join("\n")}`);

    const note = (notepad ?? "").trim();
    if (note) parts.push(`# 메모장 (${name}의 작업 메모)\n${capText(note, 2000)}`);

    parts.push(SAFETY_NOTICES);
    return parts.filter(Boolean).join("\n\n");
  }

  // ───────────── memory ─────────────

  async appendDaily(userId: string, e: { user: string; assistant: string; at: Date }): Promise<void> {
    assertUserId(userId);
    return this.#serial(userId, async () => {
      const key = kstDateKey(e.at);
      const path = this.#p(userId, "memory", "daily", `${key}.md`);
      const prev = (await readText(path)) ?? `# ${key} 대화 기록\n`;
      const entry = `\n## ${kstClock(e.at)}\n- 사용자: ${oneLine(scrubSecrets(e.user ?? ""), FIELD_CAP)}\n- 에이전트: ${oneLine(scrubSecrets(e.assistant ?? ""), FIELD_CAP)}\n`;
      await atomicWrite(path, prev.endsWith("\n") ? prev + entry : `${prev}\n${entry}`);
    });
  }

  async #readFacts(userId: string): Promise<Fact[]> {
    const raw = (await readText(this.#p(userId, "memory", "facts.md"))) ?? "";
    const facts: Fact[] = [];
    for (const line of raw.split("\n")) {
      const m = FACT_LINE.exec(line);
      if (m) facts.push({ text: m[1]!.trim(), id: m[2]!, createdAt: Number(m[3]) });
      else if (/^-\s+\S/.test(line)) {
        // a line someone added by hand: give it a stable id
        const text = line.replace(/^-\s+/, "").trim();
        facts.push({ text, id: `h${hash32(text).toString(36)}`, createdAt: 0 });
      }
    }
    return facts;
  }

  async #writeFacts(userId: string, facts: Fact[]): Promise<void> {
    const body = facts.map((f) => `- ${f.text} <!-- id:${f.id} at:${f.createdAt} -->`).join("\n");
    await atomicWrite(this.#p(userId, "memory", "facts.md"), `${FACTS_HEADER}${body}${body ? "\n" : ""}`);
  }

  /** Save a durable fact (deduplicated). Throws for secret-looking text. */
  async remember(userId: string, text: string): Promise<{ id: string }> {
    assertUserId(userId);
    const clean = oneLine(String(text ?? "").replace(/<!--|-->/g, ""), FIELD_CAP);
    if (!clean) return Promise.reject(new Error("empty memory"));
    if (looksSecret(clean)) return Promise.reject(new Error("refusing to store secret-looking text"));
    return this.#serial(userId, async () => {
      const facts = await this.#readFacts(userId);
      const norm = (s: string) => s.replace(/[\s.!?~]+/g, "").toLowerCase();
      const dup = facts.find((f) => norm(f.text) === norm(clean));
      if (dup) return { id: dup.id };
      const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      facts.push({ id, text: clean, createdAt: Date.now() });
      await this.#writeFacts(userId, facts);
      return { id };
    });
  }

  async listMemories(userId: string): Promise<{ id: string; text: string; createdAt: number }[]> {
    assertUserId(userId);
    return (await this.#readFacts(userId)).map((f) => ({ ...f }));
  }

  async forget(userId: string, id: string): Promise<boolean> {
    assertUserId(userId);
    return this.#serial(userId, async () => {
      const facts = await this.#readFacts(userId);
      const next = facts.filter((f) => f.id !== id);
      if (next.length === facts.length) return false;
      await this.#writeFacts(userId, next);
      return true;
    });
  }

  /** BM25 over durable facts + the last 7 days of conversation logs. */
  async recall(userId: string, query: string, limit = 5): Promise<string[]> {
    assertUserId(userId);
    const docs: Bm25Doc<string>[] = (await this.#readFacts(userId)).map((f) => ({ text: f.text, item: f.text, boost: 1.3 }));
    const dailyDir = this.#p(userId, "memory", "daily");
    let files: string[] = [];
    try {
      files = (await readdir(dailyDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, DAILY_RECALL_DAYS);
    } catch {
      /* no logs yet */
    }
    for (const f of files) {
      const raw = (await readText(join(dailyDir, f))) ?? "";
      const day = f.slice(5, 10).replace("-", "/");
      for (const block of raw.split(/^## /m).slice(1)) {
        const [clock = "", ...rest] = block.split("\n");
        const body = rest.map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean).join(" / ");
        if (body) docs.push({ text: body, item: oneLine(`[${day} ${clock.trim()}] ${body}`, 400) });
      }
    }
    return bm25Search(docs, query, Math.max(1, Math.min(20, limit))).map((r) => r.item);
  }

  async notepad(userId: string): Promise<string> {
    assertUserId(userId);
    return (await readText(this.#p(userId, "notepad.md"))) ?? "";
  }

  async writeNotepad(userId: string, text: string): Promise<void> {
    assertUserId(userId);
    const t = String(text ?? "");
    const enc = new TextEncoder();
    if (enc.encode(t).length > NOTEPAD_CAP) return Promise.reject(new Error(`notepad must be ≤ ${NOTEPAD_CAP} bytes`));
    return this.#serial(userId, () => atomicWrite(this.#p(userId, "notepad.md"), t));
  }

  // ───────────── turns, status ─────────────

  async acquire(userId: string): Promise<Lease> {
    assertUserId(userId);
    return this.#leases.acquire(userId);
  }

  tryAcquire(userId: string): Lease | null {
    assertUserId(userId);
    return this.#leases.tryAcquire(userId);
  }

  steer(userId: string, text: string): boolean {
    assertUserId(userId);
    return this.#leases.steer(userId, text);
  }

  /**
   * Take (and clear) steered messages that arrived after the last turn's final steering poll. If the
   * server doesn't take them, the next lease's first drain() returns them, so they are never lost.
   */
  takeLeftoverSteers(userId: string): string[] {
    assertUserId(userId);
    return this.#leases.takeLeftover(userId);
  }

  status(userId: string): AgentStatus {
    return this.#status.get(userId)?.status ?? "idle";
  }

  setStatus(userId: string, s: AgentStatus): void {
    const cur = this.#status.get(userId);
    if (cur?.status === s) return;
    if (s === "idle") this.#status.delete(userId);
    else this.#status.set(userId, { status: s, since: Date.now() });
  }

  async #touch(userId: string): Promise<void> {
    await this.#serial(userId, async () => {
      const c = await this.#readConfig(userId);
      if (!c) return;
      c.launcher.lastActiveAt = Date.now();
      await this.#writeConfig(userId, c);
    }).catch((err: unknown) => {
      console.warn(`[pickle/launcher] could not record lastActiveAt for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Reset caches and repair the workspace. A running turn is not interrupted (the server owns its AbortController). */
  async restart(userId: string): Promise<void> {
    assertUserId(userId);
    this.setStatus(userId, "starting");
    this.#cache.clear(this.workspaceDir(userId));
    try {
      await this.reconcile([userId]);
      this.setStatus(userId, this.#leases.isHeld(userId) ? "running" : "idle");
    } catch (err) {
      this.setStatus(userId, "error");
      throw err;
    }
  }

  /** Ensure workspaces exist and are complete. Never deletes anything. */
  async reconcile(userIds: string[]): Promise<{ created: string[]; repaired: string[] }> {
    const created: string[] = [];
    const repaired: string[] = [];
    for (const userId of userIds) {
      assertUserId(userId);
      await this.#serial(userId, async () => {
        let c: WorkspaceConfig | null;
        let wasCorrupt = false;
        try {
          c = await this.#readConfig(userId);
        } catch (err) {
          if (!(err instanceof CorruptConfigError)) throw err;
          await this.#quarantine(userId);
          c = null;
          wasCorrupt = true;
        }
        if (!c) {
          const fresh = this.#freshConfig(userId, { agentName: "모시", displayName: "사용자" }, true);
          await this.#writeConfig(userId, fresh);
          await this.#ensureFiles(userId, fresh, false);
          (wasCorrupt ? repaired : created).push(userId);
          return;
        }
        let changed = false;
        const rewrite = c.launcher.safetyVersion !== this.safetyVersion;
        if (rewrite || c.launcher.model !== this.model) {
          c.launcher.safetyVersion = this.safetyVersion;
          c.launcher.model = this.model;
          await this.#writeConfig(userId, c);
          changed = true;
        }
        const fixed = await this.#ensureFiles(userId, c, rewrite);
        if (changed || fixed.length) repaired.push(userId);
      });
    }
    return { created, repaired };
  }

  running(): { userId: string; status: AgentStatus; since: number }[] {
    return [...this.#status.entries()]
      .filter(([, v]) => v.status === "running" || v.status === "starting")
      .map(([userId, v]) => ({ userId, status: v.status, since: v.since }));
  }
}

class CorruptConfigError extends Error {
  constructor(userId: string) {
    super(`corrupt config.json for ${userId}`);
    this.name = "CorruptConfigError";
  }
}
