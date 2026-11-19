/**
 * Live smoke test against the hosted k-skill proxy. Skipped unless KSKILL_LIVE=1.
 *   KSKILL_LIVE=1 bun test packages/skills/test/live.test.ts
 * Uses ~7 proxy requests (the proxy allows 60/min per client).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolResult } from "@pickle/agent";
import { httpStats, kHolidays, kNews, kPlaceSearch, kSubwayArrival, kWeather, resetHttpState, setFetch, type SkillTool } from "../src/index";
import { fakeCtx } from "./helpers";

const LIVE = process.env.KSKILL_LIVE === "1";

async function run(tool: SkillTool, args: Record<string, unknown>): Promise<ToolResult> {
  const started = performance.now();
  const r = await tool.run(args, fakeCtx({ now: () => new Date() }));
  const ms = Math.round(performance.now() - started);
  console.log(`[live] ${tool.name} ${JSON.stringify(args)} → ok=${r.ok} ${ms}ms · ${r.summary}`);
  return r;
}

describe.skipIf(!LIVE)("k-skill proxy (live)", () => {
  beforeAll(() => {
    setFetch(null);
    resetHttpState();
  });

  test("k_weather 서울", async () => {
    const r = await run(kWeather, { place: "서울" });
    expect(r.ok).toBe(true);
    expect(r.card?.type).toBe("weather");
  }, 20_000);

  test("k_subway_arrival 강남", async () => {
    const r = await run(kSubwayArrival, { station: "강남" });
    expect(r.ok).toBe(true);
    expect(r.card?.type).toBe("results");
  }, 20_000);

  test("k_news AI", async () => {
    const r = await run(kNews, { query: "AI" });
    expect(r.ok).toBe(true);
  }, 20_000);

  test("k_place_search 성수동 카페", async () => {
    const r = await run(kPlaceSearch, { query: "카페", near: "성수동" });
    expect(r.ok).toBe(true);
  }, 20_000);

  test("k_holidays", async () => {
    const r = await run(kHolidays, {});
    expect(r.ok).toBe(true);
    console.log(`[live] network requests: ${httpStats().network}`);
  }, 20_000);
});
