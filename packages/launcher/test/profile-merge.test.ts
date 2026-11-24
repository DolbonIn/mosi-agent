/**
 * update() merges only the fields a patch sends (a partial avatar, per-skill `skills` toggles, an older app's whole
 * `enabledSkills` list) inside the per-user queue, so two patches sent at once both keep their change; `changed` and
 * the config's rev move only when a value does, and the rev never goes back (a re-provision keeps it, a config made
 * anew after a corrupt one starts above it).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLauncher, NoSkillsError, applyAgentPatch, nextRev } from "../src/index.ts";

const roots: string[] = [];
afterAll(async () => {
  await Bun.sleep(30);
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

let root = "";
let L: AgentLauncher;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pickle-launcher-merge-"));
  roots.push(root);
  L = new AgentLauncher({ rootDir: root, model: "m" });
});

const INIT = { agentName: "깽이", displayName: "하늘", enabledSkills: ["k.weather", "k.news", "k.bus"] };
const config = async (u = "u1") => readFile(join(root, u, "config.json"), "utf8");
const rev = async (u = "u1") => (await L.profile(u))!.rev;

describe("update merges only what a patch sends", () => {
  test("two skill toggles sent at once both stay; each raises the rev once", async () => {
    await L.provision("u1", INIT);
    const before = await rev();
    const [a, b] = await Promise.all([L.update("u1", { skills: { "k.news": false } }), L.update("u1", { skills: { "k.sub": true } })]);
    expect((await L.profile("u1"))!.enabledSkills).toEqual(["k.weather", "k.bus", "k.sub"]);
    expect([a.changed, b.changed]).toEqual([true, true]);
    const [lo, hi] = [a.profile.rev, b.profile.rev].sort((p, q) => p - q);
    expect(lo!).toBeGreaterThan(before);
    expect(hi!).toBeGreaterThan(lo!);
    expect(await rev()).toBe(hi!);
  });

  test("a hue alone keeps shape and eyes; name and persona change apart", async () => {
    await L.provision("u1", INIT);
    await L.update("u1", { avatar: { hue: 10, shape: "drop", eyes: "smile" }, persona: "다정한 깽이" });
    const r = await L.update("u1", { avatar: { hue: 200 } });
    expect(r.profile.avatar).toEqual({ hue: 200, shape: "drop", eyes: "smile" });
    const n = await L.update("u1", { name: "몽이" });
    expect(n.profile).toMatchObject({ name: "몽이", persona: "다정한 깽이" });
  });

  test("an older app's whole list still replaces the list", async () => {
    await L.provision("u1", INIT);
    const r = await L.update("u1", { enabledSkills: ["k.bus"] });
    expect(r).toMatchObject({ changed: true, profile: { enabledSkills: ["k.bus"] } });
  });

  test("an empty list (every skill) is spread to the catalog before a toggle", async () => {
    await L.provision("u1", { ...INIT, enabledSkills: [] });
    const r = await L.update("u1", { skills: { "k.news": false } }, { allSkills: ["k.weather", "k.news", "k.bus"] });
    expect(r.profile.enabledSkills).toEqual(["k.weather", "k.bus"]);
  });

  test("toggles that leave no skill on are refused and change nothing; skills with enabledSkills is refused", async () => {
    await L.provision("u1", { ...INIT, enabledSkills: ["k.weather"] });
    const was = await config();
    await expect(L.update("u1", { skills: { "k.weather": false } })).rejects.toBeInstanceOf(NoSkillsError);
    await expect(L.update("u1", { skills: { "k.news": true }, enabledSkills: ["k.news"] })).rejects.toThrow();
    await expect(L.update("u1", { avatar: { hue: 999 } })).rejects.toThrow();
    expect(await config()).toBe(was);
  });

  test("a patch that changes no value: changed false, same rev, the config not rewritten", async () => {
    await L.provision("u1", INIT);
    await L.update("u1", { name: "몽이", avatar: { hue: 30 } });
    const was = await config();
    const r = await L.update("u1", { name: "몽이", avatar: { hue: 30 }, skills: { "k.weather": true, "k.nope": false } });
    expect(r.changed).toBe(false);
    expect(r.profile.rev).toBe(JSON.parse(was).rev);
    expect(await config()).toBe(was);
  });

  test("the persona the person saves is written to SOUL.md even when the config already held it", async () => {
    await L.provision("u1", INIT);
    await L.update("u1", { persona: "새 페르소나" });
    await writeFile(join(root, "u1", "SOUL.md"), "# 페르소나\n\n손으로 고친 것\n");
    const r = await L.update("u1", { persona: "새 페르소나" });
    expect(r.changed).toBe(false);
    expect(await readFile(join(root, "u1", "SOUL.md"), "utf8")).toContain("새 페르소나");
  });

  test("applyAgentPatch never mutates the profile it is given", () => {
    const cur = { name: "깽이", persona: "p", avatar: { hue: 1, shape: "blob" as const, eyes: "dot" as const }, enabledSkills: ["a", "b"] };
    const copy = structuredClone(cur);
    applyAgentPatch(cur, { skills: { a: false, c: true }, avatar: { hue: 9 } });
    expect(cur).toEqual(copy);
  });
});

describe("a persona alone (DD 2340)", () => {
  test("changed, the rev raised, and kept in the config, not only in SOUL.md: a new launcher reads it back", async () => {
    await L.provision("u1", INIT);
    const before = await rev();
    const r = await L.update("u1", { persona: "차분하고 짧게 말해요" });
    expect(r.changed).toBe(true);
    expect(r.profile.persona).toBe("차분하고 짧게 말해요");
    expect(r.profile.rev).toBeGreaterThan(before);
    expect(JSON.parse(await config()).user.persona).toBe("차분하고 짧게 말해요");
    expect((await new AgentLauncher({ rootDir: root, model: "m" }).profile("u1"))!.persona).toBe("차분하고 짧게 말해요");
  });
});

describe("the rev never goes back", () => {
  test("nextRev = max(previous + 1, clock ms)", () => {
    expect(nextRev(5, 3)).toBe(6);
    expect(nextRev(5, 100)).toBe(100);
    expect(nextRev(undefined, 7)).toBe(7);
    expect(nextRev(0, 0)).toBe(1);
  });

  test("a restart (a new launcher on the same folder) keeps it; a config put back from a backup still goes above every rev handed out", async () => {
    await L.provision("u1", INIT);
    const r1 = (await L.update("u1", { name: "가" })).profile.rev;
    const L2 = new AgentLauncher({ rootDir: root, model: "m" }); // the server restarted
    expect(await L2.profile("u1")).toMatchObject({ name: "가", rev: r1 });
    const r2 = (await L2.update("u1", { name: "나" })).profile.rev;
    expect(r2).toBeGreaterThan(r1);
    const backup = await config();
    await L2.update("u1", { name: "다" });
    const r4 = (await L2.update("u1", { name: "라" })).profile.rev;
    await writeFile(join(root, "u1", "config.json"), backup); // put back: the stored rev is r2 again
    expect(await rev()).toBe(r2);
    await Bun.sleep(5); // the clock part: above r4 unless 1000+ changes came in a second
    expect((await L2.update("u1", { name: "마" })).profile.rev).toBeGreaterThan(r4);
  });

  test("a re-provision (new model, new safety version) keeps it; a config written before revisions reads 0, then the clock", async () => {
    await L.provision("u1", INIT);
    await L.update("u1", { name: "몽이" });
    const r = await rev();
    expect(r).toBeGreaterThan(0);
    const L2 = new AgentLauncher({ rootDir: root, model: "m2", safetyVersion: 9 });
    expect((await L2.provision("u1", INIT)).rev).toBe(r);
    const c = JSON.parse(await config());
    delete c.rev;
    await writeFile(join(root, "u1", "config.json"), JSON.stringify(c));
    expect(await rev()).toBe(0);
    const t = Date.now();
    expect((await L.update("u1", { name: "콩이" })).profile.rev).toBeGreaterThanOrEqual(t);
  });

  test("a config made anew after a corrupt one starts above every rev the old one had", async () => {
    await L.provision("u1", INIT);
    for (const name of ["가", "나", "다"]) await L.update("u1", { name });
    const old = await rev();
    await Bun.sleep(5); // a fresh config starts from the clock in ms: above old revs unless 1000+ changes came in a second
    await writeFile(join(root, "u1", "config.json"), "{broken");
    expect(await L.profile("u1")).toBeNull();
    const fresh = await L.provision("u1", INIT);
    expect(fresh.rev).toBeGreaterThan(old);
  });

  test("a value a re-provision repairs from init data raises it", async () => {
    await L.provision("u1", INIT);
    const r = await rev();
    const c = JSON.parse(await config());
    c.user.avatar = { hue: "x" };
    await writeFile(join(root, "u1", "config.json"), JSON.stringify(c));
    expect((await L.provision("u1", INIT)).rev).toBeGreaterThan(r);
  });
});
