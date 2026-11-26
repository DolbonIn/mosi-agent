/**
 * A steered line is the model's copy of the person's line, files included (up to 4,000 characters of text and 50,000 of
 * text files): the lease takes it whole up to 64,000 characters, trimmed; 4,000 before 11-26 cut a file sent while the
 * agent was working, with no note.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLauncher, MAX_STEER_CHARS } from "../src/index.ts";

const roots: string[] = [];
afterAll(async () => {
  await Bun.sleep(30);
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

test("a steered line up to 64,000 characters comes out whole (trimmed); a longer one comes out as its first 64,000", async () => {
  expect(MAX_STEER_CHARS).toBe(64_000);
  const root = await mkdtemp(join(tmpdir(), "pickle-launcher-"));
  roots.push(root);
  const L = new AgentLauncher({ rootDir: root, model: "deepseek/deepseek-v4.1-flash-eco" });
  const lease = await L.acquire("u1");
  const fileLine = "[첨부: 지시문.txt]\n" + "가나다라마바사아자차\n".repeat(5_500); // 60,000 + 15 characters
  expect(L.steer("u1", `  ${fileLine}\n`)).toBe(true);
  const over = "x".repeat(70_000);
  lease.steer(over);
  lease.steer("   ");
  expect(lease.drain()).toEqual([fileLine.trim(), over.slice(0, 64_000)]);
  lease.release();
});
