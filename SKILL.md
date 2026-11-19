---
name: pickle-liquid-glass-ui
description: "Design + motion rules for apps/mobile: Apple Liquid Glass material, Apple-tuned springs, and HIG usability rules, each mapped to the file that implements it. Use when building or editing any screen, surface, transition, or control in this app."
---

# Pickle Liquid Glass UI skill

Every rule below names the code that enforces it. Rows marked **Not yet** are rules
this app follows as design intent but the code does not implement yet; do not cite
them as done.

Sources: the user's two Liquid Glass UI-motion specs (iOS 26 / macOS Tahoe 26
keynote-style motion), general Apple HIG principles, and the REA of the real Pickle app.
The full HIG document crawl and the 60fps.design research the user asked for are a
follow-up (P7), not inputs to this version.

## 1. Material — Liquid Glass is a lens, not frosted plastic

| Rule | Value | Where |
|---|---|---|
| Glass surface | `backdrop-filter: blur(20px) saturate(1.7)`, white tint `--glass-tint: 0.14` (spec range 10–16%) | `styles.css .glass` |
| Specular rim | 1px masked gradient border lit top-left (135°, .85 → 0 → .25 counter-highlight bottom-right) + inset 1px highlights | `styles.css .glass-rim`, `LiquidGlass.tsx` |
| Contact shadow | `0 10px 30px rgba(0,0,0,.12)` | `styles.css .glass` |
| Real refraction | Tab-bar droplet is a `liquid-glass-js` lens: convexity +1 (magnifies the icons under it), curvature 4 (squircle), scale 12, depth 9, chroma .2, clipped to the droplet's rounded rect, `pointer-events: none`, re-cloned when the springs settle | `ui/useDropletLens.ts` |
| Glass never on glass | Content cards are opaque white (24px, `0 8px 28px` 9%); the droplet inside the tab bar is a 55% white vibrant fill, not a second blur layer | `styles.css .card`, `.droplet` |
| Concentric corners | inner = outer − inset via `concentric()`: tab bar 34 − 12 = droplet 22; composer 28 − 6 = call button 22 | `ui/geometry.ts`, `TabBar.tsx`, `Composer.tsx` |
| Dynamic Island | The only pure-black element; opaque, never glass; status dot is solid teal | `ui/DynamicIsland.tsx`, `.island` |
| Scroll-edge effect | Content fades out under the floating top bar and tab bar (taller fade above the composer on chat) via `mask-image` on the scroll container, so text never collides with chrome | `styles.css .screen`, `.has-composer` |
| No gradients on chrome | Quota fill and island dot are solid; the specular rim is the only gradient | `styles.css` |
| **Not yet** | Smooth-union (smooth-min k≈24px) when shapes split/merge; specular highlight that shifts with motion; brighter rim on press; adaptive dim under text from sampled wallpaper luminance | — |

## 2. Motion — Apple springs, small overshoot

Springs are `(response, dampingFraction)` converted in `motion/springs.ts`:
`stiffness = (2π/response)²`, `damping = 2ζ·(2π/response)`, `mass = 1`.

| Use | response | damping | token | overshoot |
|---|---|---|---|---|
| Morphs (size/radius/material, screen enter) | 0.45 | 0.86 | `MORPH` | ~0.5% |
| Presses | 0.25 | 0.72 | `PRESS` | ~3.8% (spec-mandated value; above the 3% cap) |
| Selection snap, tab icons, segment knob | 0.30 | 0.90 | `SNAP` | ~0.1% |
| Camera / large layout | 0.60 | 1.00 | `CAMERA` | 0 |
| Leading edge of a moving selection | 0.28 | 0.86 | `LEAD` | |
| Trailing edge of a moving selection | 0.42 | 0.86 | `TRAIL` | |

- **Asymmetric droplet:** the tab droplet's two edges are separate motion values; the
  edge in the direction of travel rides `LEAD`, the other rides `TRAIL`, and width =
  right − left, so it stretches ahead and settles back (`ui/TabBar.tsx`).
- **Content swap, never crossfade:** exit 120ms (blur 6px, scale .96, fade, ease-in),
  enter 60ms later on `MORPH`, `AnimatePresence mode="wait"` so exit and enter text never
  overlap; after enter the filter is set to `none` so text is not left under a filter
  (`App.tsx`). The same blur-swap is used for the archive segment content.
- **Press:** interactive glass lifts to scale 1.08 on `PRESS` and never shrinks (composer).
- **Icon optical size:** the selected tab icon's container scales 1.12; glyph stroke
  weight stays 1.8 everywhere.
- **Wallpaper:** r3f full-screen shader, four soft color fields drifting slowly
  (`t·0.03`), tab parallax of 0.012 UV per tab eased 5% per frame (`three/Wallpaper.tsx`).
- **Reduced motion:** `MotionConfig reducedMotion="user"` for framer-motion plus a
  `prefers-reduced-motion` CSS rule.
- **Banned:** bouncy/elastic easing, particle bursts, neon glows, colored gradients on
  chrome, crossfades between states, emoji, mismatched icon weights, `will-change` on
  anything the camera scales.

## 3. Color & type (light mode system materials)

- Labels `#1D1D1F`, secondary `#6E6E73`, opaque surfaces white.
- One accent `#0A84FF`, used only for on / active / selected states and primary actions.
- Wallpaper color fields: deep blue `#1B3A8C`, teal `#2BB3B1`, violet `#7B5CFF`,
  warm peach `#FFB38A` over `#F5F5F7`; a CSS radial-gradient copy sits behind the canvas
  as a no-WebGL fallback.
- Type: system stack (`-apple-system`, SF Pro, Apple SD Gothic Neo, Malgun Gothic,
  Inter); 600 titles / 500 labels / 400 body; −1% to −2% tracking at display sizes;
  `.tnum` tabular numbers for changing numbers.
- Korean: `word-break: keep-all` so words never split mid-syllable.

## 4. HIG usability

- Hit targets ≥ 44pt (`.icon-btn` 44×44; tab buttons 78 wide).
- One primary action per card (`부탁하기`, the call button).
- Floating glass tab bar with 4 tabs: 채팅 / 둘러보기 / 보관함 / 나의 모시.
- Category chips are one horizontal rail that bleeds to the screen edges; they never wrap.
- **Not yet:** `env(safe-area-inset-*)` padding (viewport-fit=cover is set; insets are
  hard-coded for a 390×844 frame).

## 5. Server-driven UI

The real app renders a UI-definition tree from `/api/ui-definitions`. Here
`apps/server` serves that shape as mock JSON, while `apps/mobile` currently renders
from local mock data in the same shape (`data/mock.ts`). Fetching the tree and a total
node renderer (unknown node → safe fallback) are P1.
