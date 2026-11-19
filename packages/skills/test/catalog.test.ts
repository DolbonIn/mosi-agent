import { describe, expect, test } from "bun:test";
import { KSKILL_PROXY, listSkills, SKILL_TOOLS, skillCatalogForPrompt, skillTools } from "../src/index";

const REQUIRED = [
  "k_weather",
  "k_fine_dust",
  "k_subway_arrival",
  "k_seoul_bike",
  "k_place_search",
  "k_directions",
  "k_news",
  "k_shopping",
  "k_gas_prices",
  "k_holidays",
  "k_performances",
  "k_travel_safety",
  "k_stock",
  "k_law_search",
  "k_real_estate",
  "k_gov_support",
  "k_housing_notices",
  "k_school_lunch",
  "k_library_books",
  "k_han_river",
];

describe("catalog", () => {
  test("KSKILL_PROXY defaults to the hosted proxy (or the env override)", () => {
    expect(KSKILL_PROXY).toBe((process.env.KSKILL_PROXY_BASE_URL || "https://k-skill-proxy.nomadamas.org").replace(/\/+$/, ""));
  });

  test("every fixed tool name exists exactly once", () => {
    const names = skillTools().map((t) => t.name);
    for (const n of REQUIRED) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });

  test("tool definitions are valid OpenAI function specs", () => {
    for (const t of SKILL_TOOLS) {
      expect(t.name).toMatch(/^k_[a-z0-9_]{1,62}$/);
      expect(t.description.length).toBeGreaterThan(60);
      expect(t.parameters.type).toBe("object");
      expect(t.parameters.additionalProperties).toBe(false);
      for (const r of t.parameters.required ?? []) expect(Object.keys(t.parameters.properties)).toContain(r);
      for (const p of Object.values(t.parameters.properties)) expect(typeof p.description).toBe("string");
      // Korean chip title, robust to garbage args
      expect(t.title({})).toMatch(/[가-힣]/);
      expect(t.title({ place: 3, query: null } as unknown as Record<string, unknown>)).toMatch(/[가-힣]/);
      // read-only lookups have no approval; a write (connection) tool must have one
      if (t.write) expect(typeof t.approval).toBe("function");
      else expect(t.approval).toBeUndefined();
    }
  });

  test("listSkills matches the protocol SkillInfo contract", () => {
    const skills = listSkills();
    expect(skills.map((s) => s.id)).toEqual(SKILL_TOOLS.map((t) => t.name));
    // the web tools ride along with every tool list but are not k-skill catalog rows
    expect(skillTools().map((t) => t.name)).toEqual([...SKILL_TOOLS.map((t) => t.name), "web_search", "web_read"]);
    for (const s of skills) {
      // proxy tools are keyless; connection tools need the owner's login (the server fills `configured` per owner)
      expect(s.needsKey).toBe(!!s.connection);
      expect(s.configured).toBe(!s.connection);
      expect(s.source).toStartWith("NomaDamas/k-skill · ");
      expect(s.title).toMatch(/[가-힣]/);
      expect(s.description).toMatch(/[가-힣]/);
      expect(s.category.length).toBeGreaterThan(0);
    }
  });

  test("enabled filter accepts SkillInfo ids and legacy dotted ids", () => {
    const web = ["web_search", "web_read"];
    expect(skillTools(["k_weather", "k.news"]).map((t) => t.name)).toEqual(["k_weather", "k_news", ...web]);
    expect(skillTools([]).map((t) => t.name)).toEqual(web);
    expect(skillTools(["unknown"]).map((t) => t.name)).toEqual(web);
  });

  test("prompt catalog is a compact Korean bullet list", () => {
    const all = skillCatalogForPrompt();
    expect(all.split("\n").filter((l) => l.startsWith("- k_")).length).toBe(SKILL_TOOLS.length);
    expect(all.length).toBeLessThan(5000);
    const two = skillCatalogForPrompt(["k_weather", "k_subway_arrival"]);
    expect(two).toContain("- k_weather: 날씨");
    expect(two).not.toContain("k_news");
    const none = skillCatalogForPrompt([]);
    expect(none).not.toContain("- k_");
    expect(none).toContain("- web_search: 웹 검색");
    expect(none).toContain("- web_read: 웹페이지 읽기");
  });
});
