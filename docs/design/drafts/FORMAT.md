# Draft format (impeccable de-slop drafts)

Every feature draft follows this layout, so the comparison viewer (`index.html`) can show 현재 | A | B side by side.

```
docs/design/drafts/
  index.html            viewer (built by draft-gallery)
  manifest.json         [{ "feature": "empty-thread", "title": "빈 대화와 제안", "owner": "design-director" }, …]
  _kit/                 shared kit (design-director): template.html, kit.css/kit.js (phone frame, primitives, all Icon.tsx
                        glyphs), render.mjs (captures), gallery.mjs; no token copies (see below)
  <feature>/
    meta.json
    A.html  B.html      mock of the screen (one file each; links the app's real CSS and ../_kit/, nothing remote)
    A-light.jpg A-dark.jpg B-light.jpg B-dark.jpg   captures, 390×844 @2x, JPEG q82 (png/ copies are gitignored)
    notes.md            what changed vs 현재, which issues it fixes, A vs B trade-off, recommendation
```

## meta.json

```json
{
  "feature": "empty-thread",
  "title": "빈 대화와 제안",
  "critique": "../../impeccable/critique/empty-thread.md",
  "score": "27/40",
  "current": ["chromium-light-06-chat-empty.jpg", "chromium-dark-06-chat-empty.jpg"],
  "variants": [
    {
      "id": "A",
      "name": "짧은 이름 (예: 조용한 시작)",
      "summary": "한두 문장: 무엇을 바꿨나",
      "fixes": ["P1-1", "P2-1", "slop:IT-2", "slop:CH-1", "critique:Q1"],
      "html": "A.html",
      "shots": { "light": "A-light.jpg", "dark": "A-dark.jpg" }
    },
    { "id": "B", "...": "..." }
  ],
  "recommended": "A",
  "motion": "모션은 그대로: 어떤 MOTION-SPEC 행을 유지하는지 한 줄"
}
```

- `current` lists files in `docs/design/impeccable/shots/` (see its `index.json`), light first, then dark, the same screen/state as the draft.
- `fixes` takes four forms; the viewer turns each into a chip (anything else shows as a grey tag):
  - `P1-1`: this feature's critique Priority Issue, numbered per severity from the top ("B caught" items continue the count);
  - `slop:IT-2`: a slop-inventory ID (first column of its tables);
  - `critique:Q1`: the draft answers question 1 of the critique's "Questions to Consider";
  - `settings:P2-1`: a Priority Issue from another feature's critique (named by its file), for a state that critique covers.
- Extra states of the same screen (e.g. the first-run welcome) go in `variants[].states`, each with its own `html` and `shots`.
- Scope: `empty-thread` covers both the empty thread (07) and the welcome (05); `onboarding` covers 01–04.

## Rules for the mocks

- **Same content as 현재:** the same screen, state and copy (fix the copy only where the critique says so). A draft is a refinement of the real product, not a new product. Synthetic data only: no real names, numbers or chats.
- **Design system:** link the app's real CSS, never a copy, so values cannot drift: `../../../../apps/mobile/src/styles/{tokens,base,glass}.css` and `../../../../apps/mobile/src/three/Wallpaper.css`, then `../_kit/kit.css` (the viewer's `serve.ts` maps these paths). Use the system font stack and the `apps/mobile/DESIGN.md` rules: Flat Paper, Token Radius, one accent (`--accent-fill #0071E3` for filled buttons), ≤3 glass surfaces, no icon tiles, no card-in-card, contrast ≥4.5:1.
- **Motion stays:** the drafts are static captures, but `notes.md` states which motion is kept (MOTION-SPEC rows). Never propose removing organic motion.
- **Viewport and offline:** 390×844 viewport, `viewport-fit=cover`, safe areas faked with the device frame from `_kit/`. No network requests (no web fonts, CDNs or remote images); everything is inline or relative.
- **Themes:** light and dark via `prefers-color-scheme` or `<html data-theme>`, so the capture script can force both.
- **A vs B:** A is the *conservative* refinement (remove slop, keep the layout); B is a *bolder* option (rethinks hierarchy within DESIGN.md). Both must be shippable.
- **Captures:** `node docs/design/drafts/_kit/render.mjs <feature>` (add `--engines chromium,webkit` for both engines). It uses repo-root Playwright with `channel: "chrome"` (never `playwright install`), `deviceScaleFactor: 2`, writes `<feature>/A-light.jpg` … at q82 plus `png/`, and exits 1 on any console error or failed request. Re-capture after every change. The kit's own gallery is `_kit/gallery.html`; never write `drafts/index.html` (that is the viewer).
