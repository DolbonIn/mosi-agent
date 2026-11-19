/*
 * Update the status of a submitted pick (lead only; see APPLY.md). The viewer shows the change within 10 s.
 *
 *   bun docs/design/drafts/pick-status.ts <feature> <status> [--owner x] [--commit sha] [--note "…"]
 *   bun docs/design/drafts/pick-status.ts --list
 *
 * status: submitted | applying | review | applied | blocked
 * Writes picks.json atomically (temp file + rename).
 */
import { STATUSES, MEMO_MAX, manifestFeatures, readPicks, writePicks, cleanText, textLength, type Status } from "./picks-lib.ts";

function fail(msg: string): never {
  console.error(`pick-status: ${msg}`);
  console.error('usage: bun docs/design/drafts/pick-status.ts <feature> <status> [--owner x] [--commit sha] [--note "…"]');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === "--list") {
  const picks = readPicks();
  for (const [f, p] of Object.entries(picks))
    console.log(`${f.padEnd(17)} ${p.choice.padEnd(8)} ${p.status.padEnd(10)} ${p.owner || ""} ${p.commit || ""}`.trimEnd());
  process.exit(0);
}

const pos: string[] = [];
const opt: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const m = a.match(/^--(owner|commit|note)(?:=(.*))?$/);
  if (m) {
    const v = m[2] !== undefined ? m[2] : args[++i];
    if (v === undefined) fail(`--${m[1]} needs a value`);
    opt[m[1]] = v;
  } else if (a.startsWith("--")) fail(`unknown option ${a}`);
  else pos.push(a);
}
const [feature, status] = pos;
if (!feature || !status || pos.length > 2) fail("need <feature> <status>");
if (!manifestFeatures().has(feature)) fail(`unknown feature "${feature}" (not in manifest.json)`);
if (!(STATUSES as readonly string[]).includes(status)) fail(`unknown status "${status}" (${STATUSES.join(" | ")})`);
if (opt.commit !== undefined && !/^[0-9a-f]{7,40}$/i.test(opt.commit)) fail(`--commit must be a git sha (7–40 hex)`);
if (opt.owner !== undefined && !/^[\w.-]{1,64}$/.test(opt.owner)) fail(`--owner must be a teammate name`);

let picks;
try {
  picks = readPicks();
} catch (e) {
  fail(`picks.json is not valid JSON: ${(e as Error).message}`);
}
const entry = picks[feature];
if (!entry) fail(`no pick has been submitted for "${feature}"`);

entry.status = status as Status;
if (opt.owner !== undefined) entry.owner = opt.owner;
if (opt.commit !== undefined) entry.commit = opt.commit.toLowerCase();
if (opt.note !== undefined) {
  const note = cleanText(opt.note);
  if (textLength(note) > MEMO_MAX) fail(`--note is longer than ${MEMO_MAX} characters`);
  if (note) entry.note = note;
  else delete entry.note;
}
if (status === "blocked" && !entry.note) console.warn("pick-status: blocked without --note; the viewer will show no reason");
entry.updatedAt = new Date().toISOString();
writePicks(picks);
const { history, ...rest } = entry;
console.log(JSON.stringify({ feature, ...rest, memo: rest.memo ? `(${textLength(rest.memo)} chars)` : "", history: history?.length || 0 }));
