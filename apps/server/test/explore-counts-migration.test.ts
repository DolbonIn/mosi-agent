/**
 * Migration v4: explore counts are real delegations only. A database from before (v3) had made-up counts seeded into
 * template_counts ("17,166명이 맡겼어요"); v4 takes exactly the seeded amount out of each row, so delegations made since
 * stay and nothing goes below 0.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/schema.ts";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test("a v3 database loses the seeded counts and keeps its real delegations", () => {
  dir = mkdtempSync(join(tmpdir(), "pickle-counts-"));
  const path = join(dir, "pickle.db");
  const old = new Database(path);
  for (let i = 0; i < 3; i++) old.exec(MIGRATIONS[i]!);
  old.exec("PRAGMA user_version = 3");
  // what v3's seedTemplates left behind, plus real use since: 2 delegations of call-demo, 1 of gov-benefits, and a row
  // someone lowered by hand below its seed
  const rows: [string, number][] = [
    ["call-demo", 17166 + 2],
    ["gov-benefits", 7734 + 1],
    ["morning-briefing", 5120],
    ["connect-kakao", 1000],
    ["not-a-seed", 4],
  ];
  for (const [id, n] of rows) old.query("INSERT INTO template_counts (template_id, count) VALUES (?, ?)").run(id, n);
  old.close();

  const db = new Db(path);
  expect(db.schemaVersion).toBe(MIGRATIONS.length);
  db.close();
  const ro = new Database(path, { readonly: true });
  const counts = Object.fromEntries((ro.query("SELECT template_id, count FROM template_counts").all() as { template_id: string; count: number }[]).map((r) => [r.template_id, r.count]));
  ro.close();
  expect(counts).toEqual({ "call-demo": 2, "gov-benefits": 1, "morning-briefing": 0, "connect-kakao": 0, "not-a-seed": 4 });
});
