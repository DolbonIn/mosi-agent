# Applying a picked draft

The user picks 현재 유지 / A / B per feature in the viewer (`http://127.0.0.1:8810/drafts/`) and submits. This file is
how a pick becomes the real app.

## Flow

1. **Submit.** The viewer POSTs the picks. `serve.ts` writes `picks.json` (status `submitted`) and appends one line per
   pick to `.picks.log` (gitignored).
2. **Dispatch.** The team lead watches `.picks.log` and sends the pick to the feature's owner (table below). The status
   becomes `applying`.
3. **Apply.** The owner applies the pick (see "What the owner does") and reports.
4. **Verify and commit.** The lead verifies on a clean HEAD worktree, commits, and moves the preview (`:5173`) to the new
   HEAD. The status becomes `applied` with the commit.

The viewer polls `picks.json` and shows each feature's status, plus the 적용 후 capture next to the picked draft.

- **Statuses:** `submitted` 제출됨 → `applying` 적용 중 → `review` 확인 중 → `applied` 적용됨, or `blocked` 막힘 (with a
  note).
- **현재 유지:** nothing is built. The status goes straight to `applied`, and the draft's critique fixes that don't depend
  on the layout still go to the owner's R batch.
- **Changing a pick:** submitting again replaces the pick, and `history` keeps the old one. If the old pick was already
  applied, the new one is applied on top of it.

Status updates (lead only):
`bun docs/design/drafts/pick-status.ts <feature> <status> [--owner x] [--commit sha] [--note "…"]`

## Owners

| Feature ids | Owner |
|---|---|
| chat, empty-thread, voice-call, phone-delegation, meeting | screens-chat |
| explore, archive, connections, schedules, my-mosi, payment, invite-friends, settings | screens-more |
| drawer, onboarding (app shell: `app/Drawer.tsx`, `App.tsx` / `Shell.tsx` onboarding) | mobile-foundation |

This table is the default. The lead can hand a pick to someone else, and the `owner` recorded in `picks.json` wins.
For the 2026-11-12 round:
- connections went to vault-messengers;
- archive and invite-friends went to slack-login;
- schedules went to messenger-login;
- voice-call went to voice.
The shared top-bar rule (`app/TopBar.tsx`) goes to mobile-foundation for every pick.

The server owns SDUI changes, such as row order in 나의 모시. If a draft needs one, the owner asks the server teammate
and both parts land in the same commit.

## What the owner does

- **Read the pick.** Read the picked variant's HTML (`<feature>/A.html` or `B.html`, plus `states`), `notes.md`, the
  variant's `fixes` in `meta.json`, and the user's memo. The memo overrides the draft where they differ.
- **Build it in the real app** (`apps/mobile/src/**`, plus server SDUI if needed). Use the real components and tokens.
  Don't paste the mock's markup or `_kit` CSS.
- **Keep the motion.** Keep every MOTION-SPEC row that `notes.md` lists as kept. Never remove organic motion. If the
  draft changes a MOTION-SPEC row (e.g. B's bubble-less turns), update `docs/design/MOTION-SPEC.md` in the same change.
- **Keep the rules.** Follow `apps/mobile/DESIGN.md`:
  - Flat Paper, Token Radius;
  - one accent, `--accent-fill` behind text;
  - ≤3 glass surfaces;
  - no icon tiles, no card-in-card;
  - contrast ≥4.5:1, targets ≥44 px.
- **Capture 적용 후.** Use your own preview port with synthetic data, never `:5173`/`:8787`. Capture the same screen and
  state as the draft at 390×844 @2x as `<feature>/applied-light.jpg` and `applied-dark.jpg` (q82).
- **Compare.** Look at the capture next to the picked draft. Any difference must be intended; list each one in the
  report.
- **Pass the gates:**
  - mobile `tsc`, `bun test` (qa/*.test.ts) and `vite build`, into a scratch outDir;
  - the feature's QA spec in Chrome and WebKit, light and dark;
  - for server changes, server tests.
- **Report, don't commit.** Report the files changed (your hunks only, if a file is shared), the gates, the capture paths
  and the intended differences.
