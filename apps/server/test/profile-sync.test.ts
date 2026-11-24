/**
 * The person's settings and agent profile on every device of theirs (G2/G3): a PATCH that changes a value sends the
 * whole settings (`settings`) or profile (`agent`) with its new rev to every device of the person, the sender's too,
 * never to a friend; a PATCH that changes nothing sends nothing and keeps the rev. The rev rides on everything that
 * hands the values out (PATCH answers, events, GET /api/session, GET /api/profile, GET /api/agent, `hello`), so a device
 * tells an older answer from a newer event (they come on different connections) by size alone, and a device that slept
 * with its stream closed knows from `hello` whether to re-read. PATCH /api/agent merges only the fields sent (per-skill
 * `skills` toggles, a partial avatar; an older app's whole `enabledSkills` list still works).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfile, Friend, InviteResponse, ServerEvent, SessionBootstrap, SettingsView, SkillInfo } from "@pickle/protocol";
import { Db } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/schema.ts";
import { makeHarness, sseReader, type Harness } from "./helpers.ts";

let h: Harness;
let opened = false;
afterEach(async () => {
  if (opened) await h.close();
  opened = false;
});

const skill = (id: string): SkillInfo => ({ id, title: id, description: id, category: "생활", icon: "cloud", needsKey: false, configured: true, source: "test" });
const SKILLS = ["k.weather", "k.news", "k.bus"].map(skill);
const harness = async () => {
  const made = await makeHarness({ deps: () => ({ skills: { listSkills: () => SKILLS, skillTools: () => [], skillCatalogForPrompt: () => "" } }) });
  opened = true;
  return made;
};

/** a device of the person: its /api/events stream, opened (hello received) */
async function device(token: string) {
  const ev = sseReader(await h.req("GET", `/api/events?token=${token}`));
  const hello = await ev.next<Extract<ServerEvent, { type: "hello" }>>((e) => e.type === "hello");
  expect(hello).toBeTruthy();
  return {
    hello: hello!,
    /** settings / agent events since the last call, in order */
    async got(waitMs = 60): Promise<ServerEvent[]> {
      const out: ServerEvent[] = [];
      for (;;) {
        const e = await ev.next<ServerEvent>((x) => x.type === "settings" || x.type === "agent", waitMs);
        if (!e) return out;
        out.push(e);
      }
    },
    cancel: () => ev.cancel(),
  };
}

async function befriend(x: { token: string }, y: { token: string }): Promise<Friend> {
  const inv = (await (await h.req("POST", "/api/invites", { token: x.token })).json()) as InviteResponse;
  const acc = await h.req("POST", `/api/invites/${inv.token}/accept`, { token: y.token });
  expect([200, 201]).toContain(acc.status);
  return (await acc.json()) as Friend;
}

async function patchSettings(token: string, body: unknown): Promise<SettingsView> {
  const res = await h.req("PATCH", "/api/settings", { token, body });
  expect(res.status).toBe(200);
  return (await res.json()) as SettingsView;
}

async function patchAgent(token: string, body: unknown): Promise<AgentProfile> {
  const res = await h.req("PATCH", "/api/agent", { token, body });
  expect(res.status).toBe(200);
  return (await res.json()) as AgentProfile;
}

const session = async (token: string) => (await (await h.req("GET", "/api/session", { token })).json()) as SessionBootstrap;

/** the app's rule: a value replaces what the device holds only when its rev is larger */
function newest<T extends { rev?: number }>(arrivals: T[]): T {
  return arrivals.reduce((held, x) => ((x.rev ?? -1) > (held.rev ?? -1) ? x : held));
}

function orders<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

describe("settings (G3)", () => {
  test("a change: the whole settings with the new rev to both devices of the person, rev = the answer's; the friend gets nothing", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const friend = await h.signup("byeol");
    await befriend(me, friend);
    const a = await device(me.token);
    const b = await device(me.token);
    const f = await device(friend.token);
    const before = (await session(me.token)).settings.rev!;
    expect(before).toBe(0); // no change yet
    const saved = await patchSettings(me.token, { display: { theme: "dark" } });
    expect(saved.rev).toBe(h.clock.now()); // max(0 + 1, the server clock in ms)
    expect(saved.display.theme).toBe("dark");
    for (const d of [a, b]) expect(await d.got()).toEqual([{ type: "settings", settings: saved }]);
    expect(await f.got()).toEqual([]);
    const s = await session(me.token);
    expect(s.settings).toEqual(saved);
    const p = (await (await h.req("GET", "/api/profile", { token: me.token })).json()) as { settings: SettingsView };
    expect(p.settings).toEqual(saved);
    for (const d of [a, b, f]) await d.cancel();
  });

  test("a PATCH that changes no value: no event, the same rev, the same answer", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const saved = await patchSettings(me.token, { display: { theme: "dark" }, notifications: { briefing: false } });
    const a = await device(me.token);
    const again = await patchSettings(me.token, { display: { theme: "dark" } });
    expect(again).toEqual(saved);
    expect(await patchSettings(me.token, {})).toEqual(saved);
    expect(await a.got()).toEqual([]);
    expect((await session(me.token)).settings.rev).toBe(saved.rev);
    await a.cancel();
  });

  test("different fields changed one after the other both stay; a rev in the body is refused", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const a = await device(me.token);
    const x = await patchSettings(me.token, { display: { theme: "light" } });
    const y = await patchSettings(me.token, { notifications: { briefingTime: "08:15" } });
    // the harness clock stands still, so the second write's max(previous + 1, clock) is previous + 1
    expect(y).toMatchObject({ display: { theme: "light" }, notifications: { briefingTime: "08:15" }, rev: x.rev! + 1 });
    expect((await a.got()).map((e) => (e.type === "settings" ? e.settings.rev : -1))).toEqual([x.rev, y.rev]);
    const bad = await h.req("PATCH", "/api/settings", { token: me.token, body: { rev: 99 } });
    expect(bad.status).toBe(400);
    expect((await session(me.token)).settings.rev).toBe(y.rev);
    await a.cancel();
  });

  test("the rev is never stored in settings_json, only added when the settings are handed out; a body with a rev is refused (400) and nothing is stored or sent", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const stored = () => JSON.parse(h.db.userById(me.session.user.id)!.settings_json) as Record<string, unknown>;
    const saved = await patchSettings(me.token, { display: { theme: "dark" } });
    expect(typeof saved.rev).toBe("number");
    expect(Object.keys(stored()).sort()).toEqual(["confirmBeforeSend", "display", "notifications", "privacy"]);
    expect(stored().display).toMatchObject({ theme: "dark" });
    const a = await device(me.token);
    const was = h.db.userById(me.session.user.id)!.settings_json;
    for (const body of [{ rev: 99 }, { display: { theme: "light" }, rev: saved.rev! + 5 }, { display: { theme: "light", rev: 3 } }]) {
      const res = await h.req("PATCH", "/api/settings", { token: me.token, body });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_settings");
    }
    expect(h.db.userById(me.session.user.id)!.settings_json).toBe(was);
    expect(await a.got()).toEqual([]);
    expect((await session(me.token)).settings).toEqual(saved);
    await a.cancel();
  });

  test("B saves light, A saves dark right after: in whatever order B gets its answer and the two events, the larger rev leaves B on dark, the server's value", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const b = await device(me.token);
    const light = await patchSettings(me.token, { display: { theme: "light" } }); // B's PATCH, served first
    const dark = await patchSettings(me.token, { display: { theme: "dark" } }); // A's PATCH, served second
    expect(dark.rev!).toBeGreaterThan(light.rev!);
    const events = (await b.got()).map((e) => (e as Extract<ServerEvent, { type: "settings" }>).settings);
    expect(events).toEqual([light, dark]); // each event = the answer of the PATCH it reports, rev included
    const server = (await session(me.token)).settings;
    expect(server).toEqual(dark);
    for (const order of orders([light, ...events])) expect(newest(order)).toEqual(server);
    await b.cancel();
  });
});

describe("agent profile (G2)", () => {
  test("a change: the whole profile with the new rev to both devices of the person, rev = the answer's; the friend gets nothing; GET /api/agent and the session agree", async () => {
    h = await harness();
    const me = await h.signup("haneul", { agentName: "깽이" });
    const friend = await h.signup("byeol");
    await befriend(me, friend);
    const a = await device(me.token);
    const b = await device(me.token);
    const f = await device(friend.token);
    const before = (await session(me.token)).agent.rev;
    const saved = await patchAgent(me.token, { name: "몽이" });
    expect(saved.name).toBe("몽이");
    expect(saved.rev).toBeGreaterThan(before);
    for (const d of [a, b]) expect(await d.got()).toEqual([{ type: "agent", agent: saved }]);
    expect(await f.got()).toEqual([]);
    expect((await session(me.token)).agent).toEqual(saved);
    expect(await (await h.req("GET", "/api/agent", { token: me.token })).json()).toEqual(saved);
    expect(h.db.userById(me.session.user.id)!.agent_name).toBe("몽이");
    for (const d of [a, b, f]) await d.cancel();
  });

  test("two devices toggle different skills at once: both stay, each its own rev and event; a skill switched back on joins the list", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    await patchAgent(me.token, { enabledSkills: ["k.weather", "k.news", "k.bus"] });
    const a = await device(me.token);
    const [x, y] = await Promise.all([patchAgent(me.token, { skills: { "k.news": false } }), patchAgent(me.token, { skills: { "k.bus": false } })]);
    expect((await session(me.token)).agent.enabledSkills).toEqual(["k.weather"]);
    expect(x.rev).not.toBe(y.rev);
    expect((await a.got()).map((e) => (e.type === "agent" ? e.agent.rev : -1)).sort()).toEqual([x.rev, y.rev].sort());
    const back = await patchAgent(me.token, { skills: { "k.news": true } });
    expect(back.enabledSkills).toEqual(["k.weather", "k.news"]);
    await a.cancel();
  });

  test("an empty skill list (every skill on) is spread to the catalog before a toggle switches one off", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    expect((await session(me.token)).agent.enabledSkills).toEqual([]); // the fake launcher's fresh profile
    expect((await patchAgent(me.token, { skills: { "k.news": false } })).enabledSkills).toEqual(["k.weather", "k.bus"]);
  });

  test("a hue alone keeps shape and eyes; a name alone keeps the persona; an older app's whole list still works", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    await patchAgent(me.token, { avatar: { hue: 10, shape: "drop", eyes: "smile" }, persona: "다정한 깽이" });
    expect((await patchAgent(me.token, { avatar: { hue: 200 } })).avatar).toEqual({ hue: 200, shape: "drop", eyes: "smile" });
    expect(await patchAgent(me.token, { name: "몽이" })).toMatchObject({ name: "몽이", persona: "다정한 깽이" });
    expect((await patchAgent(me.token, { enabledSkills: ["k.bus"] })).enabledSkills).toEqual(["k.bus"]);
  });

  test("a persona alone (what the app sends when only the persona changed): saved, the other device gets it with the answer's rev, GET /api/agent has it (DD 2340)", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const before = (await session(me.token)).agent;
    const a = await device(me.token);
    const saved = await patchAgent(me.token, { persona: "차분하고 짧게 말해요" });
    expect(saved).toMatchObject({ persona: "차분하고 짧게 말해요", name: before.name, avatar: before.avatar });
    expect(saved.rev).toBeGreaterThan(before.rev);
    expect(await a.got()).toEqual([{ type: "agent", agent: saved }]);
    expect(await (await h.req("GET", "/api/agent", { token: me.token })).json()).toEqual(saved);
    expect((await session(me.token)).agent).toEqual(saved);
    await a.cancel();
  });

  test("refused: skills with enabledSkills, an unknown skill, toggles that leave none on (no_skills), an empty avatar, a rev; nothing changes, no event", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    await patchAgent(me.token, { enabledSkills: ["k.weather"] });
    const was = (await session(me.token)).agent;
    const a = await device(me.token);
    const refused = async (body: unknown, code?: string) => {
      const res = await h.req("PATCH", "/api/agent", { token: me.token, body });
      expect(res.status).toBe(400);
      if (code) expect(((await res.json()) as { error: string }).error).toBe(code);
    };
    await refused({ skills: { "k.news": true }, enabledSkills: ["k.news"] });
    await refused({ skills: { "k.nope": true } });
    await refused({ skills: { "k.news": "yes" } });
    await refused({ skills: { "k.weather": false } }, "no_skills");
    await refused({ avatar: {} });
    await refused({ avatar: { hue: 400 } });
    await refused({ rev: 5 });
    expect((await session(me.token)).agent).toEqual(was);
    expect(await a.got()).toEqual([]);
    await a.cancel();
  });

  test("a PATCH that changes nothing: no event, the same rev", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const saved = await patchAgent(me.token, { name: "몽이", avatar: { hue: 30 }, enabledSkills: ["k.weather", "k.bus"] });
    const a = await device(me.token);
    expect(await patchAgent(me.token, { name: "몽이", avatar: { hue: 30 }, skills: { "k.weather": true } })).toEqual(saved);
    expect(await a.got()).toEqual([]);
    expect((await session(me.token)).agent.rev).toBe(saved.rev);
    await a.cancel();
  });

  test("B names it 콩이, A names it 몽이 right after: in whatever order B gets its answer and the two events, the larger rev leaves B on 몽이", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const b = await device(me.token);
    const first = await patchAgent(me.token, { name: "콩이" });
    const second = await patchAgent(me.token, { name: "몽이" });
    expect(second.rev).toBeGreaterThan(first.rev);
    const events = (await b.got()).map((e) => (e as Extract<ServerEvent, { type: "agent" }>).agent);
    expect(events).toEqual([first, second]);
    const server = (await session(me.token)).agent;
    expect(server).toEqual(second);
    for (const order of orders([first, ...events])) expect(newest(order)).toEqual(server);
    await b.cancel();
  });
});

test("v6: a database from before revisions keeps its users' settings and gives them rev 0; the first write raises it to the clock", () => {
  const dir = mkdtempSync(join(tmpdir(), "pickle-settings-rev-"));
  try {
    const path = join(dir, "pickle.db");
    const old = new Database(path);
    for (let i = 0; i < 5; i++) old.exec(MIGRATIONS[i]!);
    old.exec("PRAGMA user_version = 5");
    old
      .query("INSERT INTO users (id, handle, display_name, agent_name, password_hash, settings_json, created_at) VALUES ('u1', 'haneul', '하늘', '깽이', 'x', ?, 1)")
      .run(JSON.stringify({ display: { theme: "dark" } }));
    old.close();
    const db = new Db(path);
    expect(db.schemaVersion).toBe(MIGRATIONS.length);
    const u = db.userById("u1")!;
    expect(u.settings_rev).toBe(0);
    expect(JSON.parse(u.settings_json)).toEqual({ display: { theme: "dark" } });
    const t = 1_795_000_000_000;
    expect(db.setUserSettings("u1", u.settings_json, t)).toBe(t); // max(0 + 1, t)
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the settings rev never goes down: not after a restart with an earlier clock, not after the database is put back from a backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "pickle-settings-rev-"));
  try {
    const path = join(dir, "pickle.db");
    const open = () => new Db(path);
    let db = open();
    db.sql.query("INSERT INTO users (id, handle, display_name, agent_name, password_hash, settings_json, created_at) VALUES ('u1', 'haneul', '하늘', '깽이', 'x', '{}', 1)").run();
    const t = 1_795_000_000_000;
    const r1 = db.setUserSettings("u1", '{"v":1}', t);
    db.close();
    copyFileSync(path, join(dir, "backup.db"));
    db = open(); // a restart
    expect(db.userById("u1")!.settings_rev).toBe(r1);
    const r2 = db.setUserSettings("u1", '{"v":2}', t - 3_600_000); // its clock an hour behind
    expect(r2).toBe(r1 + 1);
    const r3 = db.setUserSettings("u1", '{"v":3}', t + 60_000);
    expect(r3).toBe(t + 60_000);
    db.close();
    for (const x of ["-wal", "-shm"]) if (existsSync(path + x)) rmSync(path + x);
    copyFileSync(join(dir, "backup.db"), path); // put back from the backup: the stored rev is r1 again
    db = open();
    expect(db.userById("u1")!.settings_rev).toBe(r1);
    const r4 = db.setUserSettings("u1", '{"v":4}', t + 120_000); // later than every rev handed out before
    expect(r4).toBeGreaterThan(r3);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("hello: the revisions a device that slept compares", () => {
  test("hello carries the person's settings and agent revs; a stream opened after a change shows the new ones", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const s = await session(me.token);
    const a = await device(me.token);
    expect(a.hello).toMatchObject({ settingsRev: s.settings.rev, agentRev: s.agent.rev });
    const set = await patchSettings(me.token, { display: { theme: "dark" } });
    const ag = await patchAgent(me.token, { name: "몽이" });
    const b = await device(me.token);
    expect(b.hello).toMatchObject({ settingsRev: set.rev, agentRev: ag.rev });
    expect(b.hello.settingsRev).toBeGreaterThan(a.hello.settingsRev!);
    expect(b.hello.agentRev).toBeGreaterThan(a.hello.agentRev!);
    await a.cancel();
    await b.cancel();
  });

  test("a change made while the stream reads its revs still reaches that stream as its event (the stream is registered first)", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    let open!: () => void;
    const held = new Promise<void>((r) => (open = r));
    const orig = h.launcher.profile.bind(h.launcher);
    let calls = 0;
    h.launcher.profile = async (userId: string) => {
      if (calls++ === 0) await held; // the stream's hello read waits here
      return orig(userId);
    };
    const ev = sseReader(await h.req("GET", `/api/events?token=${me.token}`));
    const saved = await patchAgent(me.token, { name: "몽이" }); // lands before hello is sent
    const set = await patchSettings(me.token, { display: { theme: "dark" } });
    open();
    expect(await ev.next((e) => e.type === "agent")).toEqual({ type: "agent", agent: saved });
    expect(await ev.next((e) => e.type === "settings")).toEqual({ type: "settings", settings: set });
    const hello = await ev.next<Extract<ServerEvent, { type: "hello" }>>((e) => e.type === "hello");
    expect(typeof hello!.settingsRev).toBe("number");
    expect(hello!.agentRev).toBe(saved.rev);
    await ev.cancel();
  });
});

describe("stand-ins when a read fails (DD 2340)", () => {
  test("the launcher cannot read the profile: the stand-in has rev 0 in the session, GET /api/agent and hello, so a device that saw the real profile keeps it", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const real = (await session(me.token)).agent;
    expect(real.rev).toBeGreaterThan(0);
    h.launcher.profile = async () => {
      throw new Error("launcher down");
    };
    const s = await session(me.token);
    expect(s.agent.rev).toBe(0);
    expect(((await (await h.req("GET", "/api/agent", { token: me.token })).json()) as AgentProfile).rev).toBe(0);
    const d = await device(me.token);
    expect(d.hello.agentRev).toBe(0);
    expect(newest([real, s.agent])).toBe(real);
    await d.cancel();
  });

  test("the revs cannot be read (the person gone meanwhile): hello still comes, without revs, and later events still reach the stream", async () => {
    h = await harness();
    const me = await h.signup("haneul");
    const id = me.session.user.id;
    const userById = h.db.userById.bind(h.db);
    let calls = 0;
    // the stream's own sign-in check reads the user first; the second read (the revs) finds no one
    h.db.userById = (u: string) => (u === id && ++calls === 2 ? null : userById(u));
    const d = await device(me.token);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(d.hello.type).toBe("hello");
    expect("settingsRev" in d.hello || "agentRev" in d.hello).toBe(false);
    const saved = await patchSettings(me.token, { display: { theme: "dark" } });
    expect(await d.got()).toEqual([{ type: "settings", settings: saved }]);
    await d.cancel();
  });
});
