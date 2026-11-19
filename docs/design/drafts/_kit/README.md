# Draft kit

This kit produces static HTML drafts of 모시 screens and renders them to PNG. Each draft is drawn with the app's real
CSS (`tokens.css`, `base.css`, `glass.css`, `three/Wallpaper.css`, loaded by relative path) and sits inside an iPhone
frame at 390×844, with a status bar, a Dynamic Island and a home indicator. It needs no build, no server and no ports,
and it never touches a camera or microphone.

| File | What |
| --- | --- |
| `template.html` | Copy this to start a draft. It contains the frame, the app chrome (menu circle, title, composer, tab bar) and the `#kit-meta` block. |
| `kit.css` | The device frame plus static copies of the app chrome geometry (`app/TopBar.css`, the `.composer` rules in `chat.css`, `app/TabBar.css`) and shared primitives: `.k-group`/`.k-row`, `.k-card`, `.k-footnote`, `.k-large-title`, `.k-section` (use an h2), `.k-btn` (primary = `--accent-fill` + white; `data-kind="neutral|plain|danger"`, `data-full`), `.k-scrim` + `.k-sheet` + `.k-sheet-title`. It uses tokens only. |
| `build-icons.mjs` | Copies every glyph from `apps/mobile/src/ui/Icon.tsx` into `kit.js`. |
| `kit.js` | Sets `?theme=light\|dark` and `?hue=0–359`, injects the wallpaper and the frame, expands `data-icon` / `data-avatar`, and prints `#kit-meta` under the phone. |
| `render.mjs` | Renders each draft at 390×844 @2x, light + dark, in Chrome. It writes `<feature>/<draft>-<theme>.jpg` (JPEG q82, the capture `../FORMAT.md` asks for) and `<feature>/png/<draft>-<theme>.png`, then rebuilds the kit gallery. |
| `gallery.mjs` | Builds `_kit/gallery.html` from every draft's `#kit-meta` and its PNGs. It can be run on its own. `../index.html` is the team's comparison viewer, built by draft-gallery per `../FORMAT.md`. The kit never writes it. |

## Commands (run from the repo root)

```sh
# 1. start a draft: ../FORMAT.md names them A.html / B.html (extra states: A-<state>.html), plus meta.json and notes.md
mkdir -p docs/design/drafts/<feature>
cp docs/design/drafts/_kit/template.html docs/design/drafts/<feature>/A.html

# 2. look at it while you work (file://; add ?theme=dark or &hue=205)
open "docs/design/drafts/<feature>/A.html"

# 3. render PNGs (Chrome, light + dark) and rebuild the gallery
node docs/design/drafts/_kit/render.mjs <feature>              # one feature
node docs/design/drafts/_kit/render.mjs                        # every feature
node docs/design/drafts/_kit/render.mjs <feature> --engines chromium,webkit --hue 205

# 4. kit gallery only (the team viewer is docs/design/drafts/index.html via `bun docs/design/drafts/serve.ts`)
node docs/design/drafts/_kit/gallery.mjs
open docs/design/drafts/_kit/gallery.html
```

`render.mjs` uses the repo-root Playwright: `channel: "chrome"` (the installed Chrome) and Playwright's WebKit. Never
run `playwright install`. A console error or a failed request, such as a wrong `../../../../apps/...` path, fails the
run with exit code 1. The output is `<feature>/<draft>-<theme>.jpg` plus `<feature>/png/<draft>-<theme>.png`; WebKit adds `-webkit`.

## Writing a draft

- **Tokens only.** Every colour, radius, type size, duration and curve is a `var(--…)` from `tokens.css`. If you need a
  value that doesn't exist, raise it as a token question instead of writing a literal.
- **The brief** (`apps/mobile/DESIGN.md` and `PRODUCT.md`):
  - at most 3 glass shapes visible;
  - paper is flat (no shadow);
  - one accent: filled buttons use `--accent-fill` (`#0071E3`, a proposed token that `kit.css` defines until
    `tokens.css` has it);
  - Korean 해요체, with no emoji;
  - the agent character is the one expressive element.
- **Rejected by the user**, so never draw them: a tab bar that minimises on scroll or focus; any re-entrance or fade
  when returning to content.
- **Motion.** Keep the organic motion. If a draft shows motion, use the app's springs:
  - `animation: … var(--dur-snap) var(--ease-snap)`;
  - press feedback with `--dur-press` / `--ease-press`.

  `render.mjs` waits for animations to finish, so each PNG shows the resting state.
- **Glyphs.** Use `<i data-icon="name" data-size="22" data-weight="regular|medium|semibold" class="…">`. The path data
  is copied from `apps/mobile/src/ui/Icon.tsx`. The names included are:
  - all 83 glyphs of `Icon.tsx` (e.g. `menu`, `chevron-left/right/down`, `search`, `checkmark`, `check-circle`, `x-circle`,
    `exclamation`, `info`, `calendar`, `phone-out`, `speaker`, `mic-off`, `slack`, `kakao`, `gear` …).
  The list is generated from `Icon.tsx` by `node docs/design/drafts/_kit/build-icons.mjs`. Re-run it when Icon.tsx
  changes. Do not draw new glyphs.
- **The agent.** Use `<i data-avatar data-size="56">`. It is the same procedural SVG as `ui/Avatar.tsx` (blob, oval
  eyes), tinted by `?hue`.
- **`#kit-meta`** (JSON) feeds the note under the phone and the gallery. Fill in:
  - `feature`, `variant` and `title`;
  - `rationale`: exactly 5 lines;
  - `motion`: what the draft keeps, with MOTION-SPEC § references;
  - `fixes`: `P1-1` (critique Priority Issues, numbered per severity from the top; "B caught" items continue the count), `slop:IT-2` (slop-inventory ID), `critique:Q1` (the draft answers that critique question), `settings:P2-1` (a Priority Issue from another feature's critique, for a state that critique covers; the prefix is that feature's manifest id, which is also its critique file name. The viewer shows it as a chip titled "설정 P2-1" that opens the issue and jumps to that critique; an unknown prefix shows as a grey tag);
  - `compare`: shot file names from `docs/design/impeccable/shots/`, which the gallery shows beside the draft.

## Known limits

- The chrome is a static copy. If `TopBar.css`, the composer or `TabBar.css` change geometry, update `kit.css`.
- Glass uses one `backdrop-filter` per element, where the app shares a BlurGroup layer. It looks the same in a still.
- No real data. Copy in drafts is written by hand from the app's strings, so keep it faithful unless the variant's point
  is a copy change, and say so in the rationale.

Proof draft: `../empty-thread/` (빈 대화와 제안, A and B, each in two states).

## Shared top-bar rule (set by design-director in review)

- Tab roots: the left circle. The centre shows the agent only on 채팅, where you talk to it. Other roots leave it empty
  until the large title collapses. Use plain text (`.k-title`) in every case, never a capsule.
- Pushed screens: back circle, and the centre stays empty at rest. Once the large title collapses on scroll, the title
  appears as plain text. Never repeat the agent's name there (slop-inventory RH-1, GL-2).
