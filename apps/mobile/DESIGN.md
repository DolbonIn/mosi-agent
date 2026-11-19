---
name: 모시
description: A Korean personal agent you talk to; iOS-26-native glass chrome over calm paper, one living character.
colors:
  accent: "#0a84ff"
  accent-text: "#0071e3"
  accent-text-dark: "#5aacff"
  accent-fill: "#0071e3"
  accent-on-droplet: "#005bb8"
  accent-on-droplet-dark: "#8cc4ff"
  on-accent: "#ffffff"
  danger: "#d70015"
  danger-dark: "#ff6961"
  bg: "#f5f5f7"
  bg-dark: "#0a0a0c"
  surface: "#ffffff"
  surface-dark: "#1c1c1e"
  surface-2: "#f2f2f7"
  surface-2-dark: "#2c2c2e"
  label: "#1d1d1f"
  label-dark: "#f5f5f7"
  label-2: "#6e6e73"
  label-2-dark: "#a1a1a6"
  island: "#000000"
  wp-light-neutral: "#ffffff"
  wp-light-neutral-dark: "#141417"
typography:
  large-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Apple SD Gothic Neo, Pretendard Variable, Noto Sans KR, system-ui, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 700
    lineHeight: 1.18
    letterSpacing: "-0.025em"
  title2:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Apple SD Gothic Neo, Pretendard Variable, Noto Sans KR, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  title3:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Apple SD Gothic Neo, Pretendard Variable, Noto Sans KR, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Apple SD Gothic Neo, Pretendard Variable, Noto Sans KR, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
  callout:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Apple SD Gothic Neo, Pretendard Variable, Noto Sans KR, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  subhead:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Apple SD Gothic Neo, Pretendard Variable, Noto Sans KR, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  footnote:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Apple SD Gothic Neo, Pretendard Variable, Noto Sans KR, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  device: "55px"
  sheet: "38px"
  sheet-inner: "28px"
  tabbar: "34px"
  droplet: "28px"
  composer: "28px"
  card: "24px"
  control: "22px"
  group: "20px"
  field: "14px"
  tile: "12px"
spacing:
  gutter: "16px"
  card-pad: "16px"
  section: "24px"
  row-min: "54px"
  target: "44px"
  topbar-h: "48px"
  tabbar-h: "68px"
components:
  button-primary:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    height: "52px"
    padding: "0 20px"
  button-neutral:
    backgroundColor: "rgb(118 118 128 / 0.12)"
    textColor: "{colors.label}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "0 18px"
  paper-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.label}"
    rounded: "{rounded.card}"
    padding: "16px"
  list-group:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.group}"
  chip:
    backgroundColor: "rgb(118 118 128 / 0.12)"
    textColor: "{colors.label}"
    rounded: "18px"
    height: "36px"
    padding: "0 14px"
  text-field:
    backgroundColor: "rgb(118 118 128 / 0.12)"
    textColor: "{colors.label}"
    rounded: "{rounded.field}"
    height: "52px"
  bubble-me:
    backgroundColor: "color-mix(in srgb, #1d1d1f 10%, transparent)"
    textColor: "{colors.label}"
    rounded: "20px"
    padding: "10px 14px"
---

<!--
  Written 2026-11-12 by design-director with the impeccable `document` method (scan mode) — Apache-2.0,
  github.com/pbakaus/impeccable; its DESIGN.md format follows google-labs-code/design.md. Values are read from
  src/styles/tokens.css, src/styles/glass.css, src/ui/*, src/app/*, src/three/Wallpaper.css and
  docs/design/MOTION-SPEC.md. tokens.css stays the source of truth: when a value here disagrees with it, tokens.css wins.
  The qualitative interview of `document` was not run with the user; the North Star and named rules below are the
  design-director's reading of the user's own instructions (quoted in "Direction").
  No .impeccable/design.json sidecar was written (the live panel is not used in this repo).
-->

# Design System: 모시

## Overview

**Creative North Star: "The Quiet Concierge"**

모시 should feel like a capable person who works for you and doesn't need to show off: the screen is calm paper and
native iOS chrome, and the only thing with a personality is the agent itself, a soft character in the user's chosen
colour that breathes when idle and reacts when it works. Information arrives as plain sentences and compact records of
what was done. Glass is the functional layer (bars, composer, sheets' chrome), never decoration; motion is organic
(springs and morphs, MOTION-SPEC) but always tied to a real state change.

The density is a messaging app's, not a dashboard's: one column, generous line-height for Hangul, cards only where a
record needs a boundary (an approval, a form, a result list). Light is the default; dark is first-class.

**Key Characteristics:**
- iOS 26 Liquid Glass chrome (top bar capsules, tab bar with droplet, composer, sheets) over an opaque content layer.
- One accent (system blue `#0A84FF`) reserved for the single primary action and on/selected states.
- The agent character (R3F blob + avatar dot + wallpaper light) carries the user's chosen hue; nothing else does.
- Spring-driven morphs (press swell, content swap, sheet-from-source, two-edge indicators) with ≤3 % overshoot.
- Calm wallpaper: `--bg` plus one soft light from the top edge, tinted 10–12 % by the agent hue (src/three/Wallpaper.css).
  See "The wallpaper" under Colors for the full spec.

### Direction: de-slop refinement (2026-11-12)

The brief, in the user's words (team-lead relays):
1. "https://github.com/pbakaus/impeccable 이거 활용해서 각 기능별 디자인의 draft 시안도 같이 만들어줘"
2. "지금 디자인 전반적으로 유기적인 모션은 남기고 slop을 지우는 방향으로 진행"
3. "뒤에 그라데이션 배경이 너무 slop인데 60fps 참고해서 깔끔하게 바꿔줘" (done by the wallpaper work: one calm light)

**The brief wins.** This is a *refinement*, not a redesign: identity, behaviour, copy and flows stay; what changes is the
generated-UI residue on top of them. Inventory with file:line: `docs/design/impeccable/slop-inventory.md`.

**Keep (non-negotiable):**
- The motion system: springs `morph · press · snap · camera · lead · trail · fade` and every primitive in MOTION-SPEC §3
  (press swell, content swap, morph-never-crossfade, two-edge indicators, sheet from source, droplet split/merge,
  loader→check, island banners) and the §8 amendments, including "returns never re-enter".
- Glass chrome as the functional layer, the specular rim and lens band, one shared blur per bar group.
- Concentric radii (inner = outer − padding).
- The agent blob as the one expressive element (onboarding hero, call screen, avatar dot, wallpaper tint).
- Hangul typography rules (keep-all, 1.5–1.7 body line-height, tabular numbers).

**Change:**
- **Icon tiles go.** Rounded-square icon plates beside or above text (briefing rows, result rows, approval/credential/
  schedule/artifact heads, empty-state glyph, thread intro, weather glyph) are removed; icons sit in flow at text size,
  or disappear when the text already says it. Hue plates stay only where they *identify a third party* (messenger and
  service logos in 연결).
- **No card inside a card.** Weather hourly tiles, the messenger excerpt panel, the approval "보낼 내용" panel and
  similar recessed blocks become rows, dividers or plain indented text inside the one card.
- **Paper is flat.** Content cards lose the two-layer drop shadow in light mode; they separate from `--bg` by value
  (`#fff` on `#f5f5f7`), as dark mode already does with a hairline. Elevation belongs to glass and sheets only.
- **One radius scale.** The ~20 literal radii in CSS (6, 7, 8, 9, 10, 11, 14, 15, 16, 18, 19, 26 px…) collapse onto the
  token scale; capsules (`height/2`) for controls, `--r-card`/`--r-group` for containers, `--r-tile` for inner tiles.
- **Glass count ≤ 3 visible shapes.** The chat screen shows up to six (menu, name capsule, 초대, composer, tab bar,
  "최신 메시지"); the top bar and the jump capsule are the draft decision.
- **Chips only where a choice is offered.** Uniform grey pills that repeat the rows above them (briefing quick replies)
  or stand in for a list (empty-thread suggestions, event notes) are rewritten as rows or plain text.
- **Say it once.** The "기기에서 암호화돼요 / 저도 볼 수 없어요" reassurance appears in the welcome text, the assistant
  reply and the card footnote; it stays only beside the password field.
- **No kicker labels** above titles ("문서" over an artifact title, "보낼 내용" over a preview); the icon or the title
  carries the type.
- **No AI-cliché glyphs.** `sparkles` as the symbol for "the agent" / "a task" is replaced by the agent's own avatar dot
  or a task-specific symbol.
- **No emoji as UI** anywhere the app renders text it controls (server event strings included).

## Colors

A neutral Apple palette with one blue for action and one hue that belongs to the agent.

### Primary
- **System Blue** (`{colors.accent}`): on/selected states (toggle on, selected chip, active tab, slider fill), tint,
  focus rings, and links on dark. As text on white it is Deep System Blue (`{colors.accent-text}`, 4.6:1); dark uses
  `{colors.accent-text-dark}`. The active tab label sits on the droplet and uses `{colors.accent-on-droplet}`
  (`{colors.accent-on-droplet-dark}` in dark); see Tab bar.
- **Action Blue** (`{colors.accent-fill}`, token `--accent-fill`): the FILL of the single primary action on a screen
  (전화 걸기, 안전하게 저장, 맡기기, 시작하기), with a white label (4.7:1), in both themes.

**The Filled Label Rule** (approved by team-lead, 2026-11-12; an accessibility fix the user may override). A label set
on any filled control clears 4.5:1 against its fill. White on `#0A84FF` is 3.6:1, measured by the impeccable detector
on every primary button, so filled buttons use `--accent-fill` `#0071E3` instead. A dark-mode fill variant is allowed
only if it also clears 4.5:1 with its label. Selected chips and other filled states follow the same rule.
`--accent-fill` is `#0071E3` in both themes in tokens.css (white 4.7:1 in light and dark).

### Neutral
- **Paper White** (`{colors.surface}`) / **Graphite Paper** (`{colors.surface-dark}`): every content card, list group,
  assistant text, sheet body.
- **Recessed Paper** (`{colors.surface-2}`): the inside of a card when a second level is unavoidable (inputs on paper).
- **Mist** (`{colors.bg}`) / **Night** (`{colors.bg-dark}`, neutral `#0A0A0C`): the page under everything; the
  wallpaper light lives on it.
- **Ink** (`{colors.label}`) and **Slate** (`{colors.label-2}`, ≥4.5:1 on surface and bg): primary and secondary text.
  `--label-3` is for placeholders and disabled glyphs only.
- **Fills** (`--fill` 12 %, `--fill-2` 20 %, `--fill-3` 28 % of `rgb(118 118 128)`): tracks, neutral buttons, chips.
- **Island Black** (`{colors.island}`): the Dynamic Island, the only pure black.

### Semantic
- **System Red** (`{colors.danger}` / `{colors.danger-dark}`): errors, the end-call button, destructive confirms. Never
  decoration.

### The agent hue
`hsl(<agent hue> 80% 58%)`, chosen per agent in 나의 모시 › agent. It appears in exactly three places: the character,
the avatar dot, and the wallpaper light (mixed 10 % light / 12 % dark toward `{colors.wp-light-neutral}`).

### The wallpaper (final spec from the wallpaper teammate, 2026-11-12)
- **CSS only, static.** No WebGL, drift, per-tab parallax or rAF. The 4-colour mesh gradient (#1B3A8C / #2BB3B1 /
  #7B5CFF / #FFB38A) and the `--wp-blue/teal/violet/peach/strength/base` tokens are deleted.
- **Base:** `--bg`, `#F5F5F7` light and `#0A0A0C` dark. The old `#0B0B12` read blue, so it was replaced by the neutral
  `#0A0A0C` (approved by team-lead, d7557c4).
- **One light:** a wide ellipse centred on the top edge (rx 150 % of the width, ry 46 % of the height). It fades to the
  base on a raised cosine, ½(1+cos πt), and never reaches below half the height.
- **Light colour:** `color-mix(in oklab, hsl(<agent hue> 80% 58%) var(--wp-light-mix), var(--wp-light-neutral))`. Light
  mode mixes 10 % into white; dark mixes 12 % into `#141417`. With no agent colour it is neutral only. It is barely
  visible: even at the top in light mode, each channel is fewer than 16 levels from the base.
- **Grain:** a static dither (SVG fractalNoise, mid grey, alpha 0–.024, about ±1 level), only over the light, against
  8-bit banding in dark. The flat base stays flat.
- **Motion:** zero at rest. When the agent colour changes, the light re-tints once on the `camera` spring (882 ms) and
  stops. With reduced motion the change is instant. During a theme swap there is no transition. With increased contrast
  or forced colours, the light is hidden and only the base shows.
- **Glass:** the WebGL SDF refraction lens is removed. `<Glass lens>` remains for compatibility and has no effect.
  Labels on glass measure ≥15:1. The tab droplet is a separate token decision, recorded under Tab bar in Components.
- **Why:** 60fps research §0 bans gradient backgrounds (S0067 Arc Search, S1954 Gemini). Depth comes from material and
  dimming, as in Grok, Perplexity and Monogram.
- **Files:** `src/three/Wallpaper.css`, `WallpaperHost.tsx`, `palette.ts` (the JS twin for the veil), the wallpaper
  block of `tokens.css`, and MOTION-SPEC §0 "Wallpaper".

### Named Rules
**The One Voice Rule.** Blue appears on at most one control per screen plus on/selected states. Invite, call, FAB,
list actions and secondary buttons are neutral. No coloured glows anywhere.
**The Agent Owns Its Colour Rule.** The agent hue never tints UI chrome, text, cards or buttons; it belongs to the
character and its light.

## Typography

**Display Font:** SF Pro Display / Apple SD Gothic Neo (system), ≥20 px
**Body Font:** SF Pro Text / Apple SD Gothic Neo, fallbacks Pretendard Variable, Noto Sans KR

**Character:** the platform's own voice, so the app reads as a native iOS app; Hangul set with care (keep-all, generous
leading, slight negative tracking only at display sizes).

### Hierarchy
- **Large Title** (700, 34 px, 1.18, −0.025em): tab roots and pushed screens; collapses into the top bar on scroll.
- **Title 2 / 3** (600, 22 / 20 px, 1.3): sheet headings, empty-state titles, call name.
- **Body** (400, 17 px, 1.55): messages, card text, list rows. Hangul body never below 1.5 line-height.
- **Callout** (400, 16 px): inputs (never smaller, or iOS zooms).
- **Subhead** (400, 15 px, 1.5): secondary lines, card bodies when dense.
- **Footnote** (400, 13 px, 1.45): meta, sources, timestamps. 13 px is the floor for any text.
- Weights: 400 body, 500 labels/chips, 600 titles and buttons, 700 large titles only.

### Named Rules
**The Tabular Rule.** Every number that changes (quota %, counts, times, prices, temperatures, call timer) is
`tabular-nums`.
**The Keep-All Rule.** `word-break: keep-all` on every Hangul text block; balance short headings with `text-wrap: balance`.

## Layout

One column at 390 × 844 with a 16 px gutter. Chrome floats: the top bar (48 px capsules at `max(safe-top, 52px)`) and
the bottom chrome (composer slot above a full-width 68 px tab bar) are fixed and never resize on scroll, focus or
keyboard (user decision 2026-11-12). Content scrolls under both with a soft mask at the edges. Vertical rhythm: 12 px
between messages, 24 px between page sections, 16 px card padding, rows ≥54 px, every target ≥44 px (chips keep a
44 px hit area around a 36 px visual). Sheets float 8 px from the screen edges with a 38 px radius and a 10 px inner
padding (concentric 28 px content).

## Elevation & Depth

Two layers. The **content layer** is opaque paper; the **functional layer** is glass. Depth comes from material, not
from stacked shadows.

### Shadow Vocabulary
- **Glass contact** (`box-shadow: 0 10px 30px rgb(0 0 0 / 0.12)`; dark `0.32`): floating glass only (bars, composer,
  capsules, banners).
- **Paper (incumbent)** (`0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.06)`, with per-file variants at
  .05/.08): every light-mode card. Slated for removal (see Direction).
- **Control knob** (`0 3px 8px rgb(0 0 0 / 0.15), 0 1px 1px rgb(0 0 0 / 0.08)`): toggle and slider knobs, segmented thumb.
- **Hairline** (`inset 0 0 0 1px var(--separator)`): dark-mode and increased-contrast paper.

### Glass
Regular glass = `rgb(255 255 255 / .14)` tint (`.56` when it carries labels) + `blur(18px) saturate(190%)
brightness(1.04)`; dark `rgb(28 28 30 / .42)`. 1 px specular rim lit from the top-left (≈.95) with a fainter
bottom-right counter-highlight (≈.5) whose angle follows motion; inset lens band for thickness. Sheets and dialogs are
opaque glass (`tint 1`, no backdrop). Reduced transparency → opaque surface + hairline; increased contrast → tint .92,
no rim.

### Named Rules
**The Two-Layer Rule.** Content is paper, chrome is glass, and nothing is glass on glass. ≤3 glass shapes visible.
**The Flat Paper Rule (new).** Paper never casts a shadow; it is separated from the page by value (light) or a hairline
(dark). Shadows are for things that float.

## Shapes

Concentric continuous corners: inner radius = outer radius − padding (sheet 38 → 28, card 24 → 12 tile, tab bar 34 →
28 droplet, composer 28 → 22 send circle). Capsules (`height / 2`) for standalone buttons, chips and fields' pills;
circles for icon-only buttons (48 px top-bar circles, 64 px call buttons). Message bubbles are 20 px with an 8 px tail
corner on the speaker's side.

### Named Rules
**The Token Radius Rule (new).** A radius is a token or `height / 2`. One-off literals (7, 9, 11, 15, 19 px…) are bugs.

## Components

### Buttons
- **Shape:** capsule (`{rounded.control}` at 44 px; 52 px tall at `size="lg"`).
- **Sizes (`ui/Button`):** md 44 px / 15 px label, lg 52 px / 17 px (sm 36 px / 13 px, hit area padded to 44). The label
  size follows the button size in every tone, neutral included; draft mocks use the same sizes.
- **Primary:** System Blue fill, white 600 label (17 px at lg). One per screen.
- **Neutral / secondary:** `--fill` + Ink label; plain variant has no fill. Destructive: `--danger-fill` + red label.
- **Press:** lift and swell on `press` (scale 1.03 opaque, up to 1.12 small glass), fill darkens 6 %; never shrinks.
- **Async:** loader → check morph (capsule contracts to a circle, ring, check draws on `snap`) only after the server
  confirms; error returns to the capsule with "다시 시도하기". High-risk confirms hold 1.2 s or take two taps.

### Chips
- **Style:** `--fill` capsule, 36 px (30 px small), 15 px 500 label; selected = `--accent-fill`, white label (Filled Label Rule).
- **Use:** a choice among peers (suggested names in onboarding, keep-for periods, categories). Not for prose.

### Cards / Containers
- **Corner Style:** `{rounded.card}` (24 px) for chat cards, `{rounded.group}` (20 px) for inset list groups.
- **Background:** Paper White / Graphite Paper.
- **Shadow Strategy:** incumbent two-layer soft shadow in light, hairline in dark; target flat (see Elevation).
- **Internal Padding:** 16 px (chat cards), 18 px (paper).

### Inputs / Fields
- **Style:** `--fill` background, `{rounded.field}` (14 px), 16 px text, label above in footnote Slate.
- **Focus:** 2 px accent ring. **Error:** 1.5 px inset red + message below with `role="alert"`.

### Navigation
- **Top bar:** three glass shapes — menu circle (left), avatar + agent name capsule (centre), contextual capsule (right,
  "초대" in chat). Pushed screens swap the menu for a back circle; the large title morphs from the row that opened it.
- **Tab bar:** full-width glass bar (68 px, r34), four tabs 채팅 · 둘러보기 · 보관함 · 나의 모시, selection droplet
  (vibrant fill + lens) moving on two edges (`lead` / `trail`).
  - **Droplet tokens** (final, a79cac9):
    - **Light:** the droplet is the grey `--fill` pill, `rgb(118 118 128 / .12)`. The old white pill vanished on the
      near-white bar glass. The active label and icon use `--accent-on-droplet` `#005bb8`.
    - **Dark:** the droplet is `rgb(118 118 128 / .42)`, and `--accent-on-droplet` is `#8cc4ff`.
    - **Contrast:** measured on the rendered pill at 12 points: the page top and bottom, plus five points each of a
      list and of a thread with cards passing under the bar. Worst cases: light 5.35:1 (Chromium) and 5.29:1
      (WebKit), dark 5.83:1 and 5.89:1. `foundation.spec` fails when the worst case is below 4.5:1, or when the
      pill can't be told from the bar.
    - The label sits on the droplet, not on paper, so it has its own token. `--accent-text` stays for accent text on
      paper (`#0071e3` light, `#5aacff` dark).
    - **Both themes:** the droplet keeps its `0 1px 2px rgb(0 0 0 / .06)` shadow.
- **Drawer:** slides from the left on `camera`; the main card scales to .96 and dims.

### Composer (signature)
Glass capsule (r28) in the bottom chrome: attach, field, mic, call. The send button morphs out of the mic when there is
text and into Stop while a turn runs.

### Dynamic Island (signature)
The agent's presence: idle pill 126 × 37, stretches for thinking / tool / streaming with status text, expands into the
call controls, drops banners. Idle is still.

### Agent character (signature)
R3F blob in the agent hue (onboarding hero, call screen), avatar dot in the top bar and lists, breathing at 3.2 s with
≤2 % amplitude, still under reduced motion.

## Do's and Don'ts

### Do:
- **Do** keep every motion on the spring tokens in `tokens.css` and every primitive in MOTION-SPEC §3; morph the same
  element, never crossfade two.
- **Do** put the screen's one primary action in System Blue and keep everything else neutral.
- **Do** use paper for records (results, approvals, forms) and plain text for conversation.
- **Do** keep content fully visible on the first frame of every return (sheet close, pop, drawer close, tab revisit).
- **Do** show the exact words that will be sent or spoken in every approval.
- **Do** use radii from the token scale or `height / 2`.

### Don't:
- **Don't** put an icon in a rounded-square tile next to or above a line of text.
- **Don't** nest a recessed panel or a grid of tiles inside a card.
- **Don't** give paper a drop shadow; don't give anything a coloured glow.
- **Don't** show more than three glass shapes at once, or put glass on glass.
- **Don't** use chips for lists, notes or prose; don't repeat a row's content as a chip under it.
- **Don't** write kicker labels above titles, or say the same reassurance twice on one screen.
- **Don't** use `sparkles`, emoji, or purple/blue gradients to signal "AI".
- **Don't** reintroduce the tab-bar minimise or any re-entrance on return (user-rejected 2026-11-12).
- **Don't** add decorative idle motion; idle is still.
