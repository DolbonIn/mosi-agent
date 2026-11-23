# Pickle — Liquid Glass + Organic Motion spec (apps/mobile)

Binding spec for every screen, component and transition of `apps/mobile`. Sources, in precedence order:
1. This file (project decisions).
2. The `apple-hig` skill (`~/.claude/skills/apple-hig` → SKILL.md §1 non-negotiables, `references/organic-motion.md`,
   `references/react-console-and-magazine.md`, `references/components-*.md`) — the full HIG crawl (173 pages EN+KR) distilled.
3. The user's two Liquid Glass motion briefs (iOS 26 / iPadOS 26 / macOS Tahoe 26 keynote-level UI motion), translated
   from "one looping video" into "a product app": every rule that is about the **element** applies; rules that only make
   sense for a rendered video (beat map, song, 1440² canvas, Playwright render, ffmpeg, audio) do not.
4. 60fps.design research (`docs/research/60fps-pickle-per-page.md`, 2026-11-11 full re-crawl). **§8 below amends §0–§7; where they disagree, §8 wins.**

---

## 0. Palette, type, iconography

| Token | Value | Use |
|---|---|---|
| `--label` | `#1D1D1F` (dark: `#F5F5F7`) | primary text |
| `--label-2` | `#6E6E73` (dark: `#A1A1A6`) | secondary text (≥4.5:1 on its surface) |
| `--surface` | `#FFFFFF` (dark: `#1C1C1E`) | opaque content cards ("paper") |
| `--fill` | `rgba(118,118,128,.12)` | tracks, chips, inactive pills |
| `--accent` | `#0A84FF` | **only** on / active / selected states and the single primary action per screen. Text on white uses `#0071E3` (4.6:1) |
| `--island` | `#000000` | the Dynamic Island — **the only pure-black element** |
| wallpaper | `--bg` (`#F5F5F7`; dark `#0A0A0C`) + one soft light from above tinted by the agent's colour | CSS only, static — see **Wallpaper** below |

- Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Display"/"SF Pro Text", "Apple SD Gothic Neo", "Pretendard Variable", "Noto Sans KR", "Malgun Gothic", Inter, system-ui`. SF Pro Display ≥20px, Text <20px. 600 titles, 500 labels, 400 body. −1% tracking at ≥20px (Hangul display −0.02em). `tabular-nums` for every number that changes (quota %, counts, times, prices, tickets).
- Body 17px / 1.55 (Hangul), captions ≥13px, inputs ≥16px (no iOS zoom), `word-break: keep-all`.
- **Wallpaper** (2026-11-12, replaces the four-field mesh gradient the user rejected as "slop"; calibrated on 60fps.design, where the
  crafted iOS apps sit on near-solid grounds and get depth from material and type — research §0 bans gradient
  backgrounds: S0067 Arc Search, S1954 Gemini). One calm surface plus at most one soft light:
  - base `--bg`: `#F5F5F7` light, `#0A0A0C` dark (neutral, no blue cast — `saturate()` in the glass would amplify one);
  - the light: `color-mix(in oklab, hsl(<agent hue> 80% 58%) --wp-light-mix, --wp-light-neutral)` — the agent's colour
    dot from the profile, 10 % into white (light) / 12 % into `#141417` (dark); no agent colour → the neutral alone;
  - shape: a wide ellipse centred on the top edge (rx 150 % of the width, ry 46 % of the height) fading to the base on a
    raised cosine (mask stops ½(1 + cos πt)), gone by half the height; you can barely tell there is a tint;
  - dither: a static mid-grey fractal grain (alpha ≤ .024, ± ~1 level) over the light's region only, against 8-bit
    banding in dark gradients; the flat base stays flat;
  - movement: none. No drift, no per-tab parallax, no rAF, no WebGL. The light re-tints once on `camera` when the
    agent's colour changes (instant under reduced motion; never during the theme swap). Reduced transparency /
    increased contrast / forced colours: the plain base.
  - `src/three/Wallpaper.css` paints it; `src/three/palette.ts` is its JS twin (the legibility veil reads it);
    `qa/wallpaper.test.ts` keeps the two in step and holds labels ≥ 7:1 on the bare wallpaper for every agent colour.
- Icons: ONE SF-Symbols-like SVG set (`ui/Icon.tsx`), stroke 1.75 at 22px (medium weight matched to 17px text), round caps/joins, one optical size per state. Icons crossing a morph keep their optical size — scale the container, never the glyph stroke. No emoji anywhere in UI chrome (the explore categories are words, not emoji or plates).

## 1. Material — Liquid Glass is a lens

- **Two layers.** Content layer = opaque `--surface` cards, text, fields, bubbles. Functional layer = glass: top bar circles (the centre is plain text, §8.17), tab bar, composer, sheets' chrome, segmented thumbs, toasts/banners, popovers, the drawer scrim edge. ≤3 glass elements visible. **Never glass on glass**: content placed on glass uses solid or vibrant fills (e.g. the tab droplet is a vibrant fill + liquid-glass-js lens, not a second backdrop blur).
- **Regular glass** (CSS, all engines): `background: rgb(255 255 255 / .14)` tint (10–16% white) + `backdrop-filter: blur(18px) saturate(190%) brightness(1.04)`; text-heavy glass raises tint to ≥.55 via `--tint`. Dark: `rgb(28 28 30 / .42)`.
- **Specular rim:** 1px masked gradient border lit from the top-left (bright ≈.95) with a fainter counter-highlight bottom-right (≈.5); the rim angle follows motion: `--rim` = 135° ± (velocity/position) so the highlight shifts as the element moves (tab droplet, sheet drag, island).
- **Lens band:** inset `0 1px 14px -8px white` + `0 -10px 18px -14px white` = thickness.
- **Contact shadow:** `0 10px 30px rgb(0 0 0 / .12)` only. No heavy drop shadows.
- ~~**Refraction where we own pixels:** SDF lenses in the WebGL wallpaper shader.~~ **Removed (2026-11-12)** with the
  WebGL wallpaper: the lenses only ever bent the wallpaper (never the HTML content), so on a calm surface they added
  nothing. All glass is CSS regular glass; `<Glass lens>` is accepted and ignored so call sites keep compiling.
- **liquid-glass-js** is used for the tab droplet's magnifying lens (convexity +1 over the icon row) — re-cloned when springs settle, disabled under reduced motion/transparency.
- **Adaptive dim for legibility:** text over glass sitting on a bright wallpaper patch gets a veil whose opacity comes from the wallpaper luminance under that rect (`veilFor`, from the wallpaper's JS twin, worst agent hue) — never a heavier tint. On the calm wallpaper it is 0 everywhere (unit-tested); it stays as the guard should the light ever get stronger.
- **Concentric corners:** inner radius = outer radius − padding, everywhere (`concentric(outer, pad)` helper). Capsules for standalone buttons, circles for icon-only. Card 24 → inner tile 24−12=12; tab bar 34 − 6 = droplet 28; composer 28 − 6 = send circle 22; sheet 38 − 10 = 28.
- **Twins:** `prefers-reduced-transparency` / setting → tint 1 (opaque), no blur, 1px hairline border. `prefers-contrast: more` → tint .92, no rim. Dark mode flips every material.

## 2. Springs (one table)

Closed-form damped step response; framer-motion uses `stiffness=(2π/response)²`, `damping=2ζ(2π/response)`, mass 1.

| Role | response / ζ | use |
|---|---|---|
| `morph` | .45 / .86 | containers changing size/radius/material, sheets, card→detail, island morphs |
| `press` | .25 / .75 | press lift-and-swell (≤3% overshoot cap, so .75 not .72) |
| `snap` | .30 / .90 | pointer/selection snap, toggles, chips |
| `camera` | .60 / 1.0 | screen-level moves, scroll-to, the wallpaper light re-tinting |
| `lead` | .28 / .86 | leading edge of a moving indicator / knob / slider stretch |
| `trail` | .42 / .86 | trailing edge |
| `fade` | .24 / 1.0 | opacity-only twins |

Rules: transform/opacity only; interruptible (retargets keep velocity — use motion values, never restart from rest); overshoot ≤3%; **no bouncy/elastic easing**; nothing moves without meaning; no dead time > 250ms in any choreography.

## 3. Interaction primitives (every one is implemented once in `ui/` and reused)

| Primitive | Behaviour |
|---|---|
| **Press** | pointerdown → glass lifts and swells: scale 1.06 (small controls up to 1.12), rim brightens (+.15), shadow unchanged. It **never shrinks**. Release springs back on `press`. Opaque buttons: lift 1.03 + fill darkens 6%. |
| **Content swap** | inside a morphing container: exit 120ms (blur 6px, scale .96, fade, ease-in) → enter starts 60ms after exit ends on its own `morph` spring (blur 6→0, scale .96→1, opacity). Exit and enter text never overlap (`AnimatePresence mode="popLayout"` scoped to the container, not whole routes). After enter, `filter: none`. |
| **Morph, never crossfade** | a state change re-shapes the same element (size, radius, material, colour) — `layout`/`layoutId` + `morph`. Two different elements are never crossfaded. Meeting B (2026-11-12, user pick): a meeting is one card from 참여 승인 through "회의에 들어와 있어요" (the agent's face, a full-width neutral 회의에서 내보내기) to "회의가 끝나서 나왔어요 · 오전 10:04 – 10:46 · 42분" — the status block under its hairline is a content swap, what the agent was going to do folds away (height on `morph`, EXIT) once the meeting is over, and the approval is one footnote line; no progress notes in that thread. Reduced motion: the states replace each other at once. |
| **Two-edge indicator** | tab droplet, segmented thumb, toggle knob, slider stretch: left and right edges are separate motion values; the edge in the direction of travel rides `lead`, the other `trail` → stretches ahead, settles. Render `translateX(L) scaleX((R−L)/base)` or width. |
| **Toggle (Focus-style)** | track + knob. Hold → knob becomes a clear enlarged glass lens (scale 1.35, tint .06) showing the track through it; flip → lens stretches in travel direction (two-edge), track fills accent on `snap`. |
| **Slider** | thickens when grabbed (6→12px track, knob lens); direct manipulation (value = f(pointer)); rubber-bands past limits `offset = limit + (1 − 1/(x·0.55/d + 1))·d`, d=60px, leading edge first; release springs back from current value **and velocity**. |
| **Droplet split/merge** | glass shapes that split or merge (tab droplet ↔ toggle knob, island ↔ banner, composer ↔ call pill) join like droplets: framer `layoutId` shared element + the shader's smooth-min union; never crossfade. |
| **Loader → check** | capsule button contracts into a circle → spinning activity ring (only while a request is in flight) → ring completes filling accent → checkmark draws itself (stroke-dashoffset on `snap`) — **only after the server confirms**. Error: back to capsule, "다시 시도하기", inputs kept. |
| **Banner / toast** | drops from the Dynamic Island: the island stretches down into a glass notification banner (icon, title, "지금") that rests just below the top bar, holds, contracts back into the island. Never claims success before the server does. A low-risk action's 5 s undo is a toast at the bottom instead (§8.13), so it never covers the top bar. |
| **Sheet** | morphs out of its source element (clip-path inset from source rect/radius → sheet rect r38), content enters 60ms later; grabber 38×5; drag down to dismiss with rubber-band; velocity-aware release; Esc/backdrop close; scroll lock; one sheet at a time; refuses close while a request is in flight. |
| **Spotlight search** | the drawer's search (and ⌘K on desktop) is a Tahoe Spotlight bar: magnifier icon, I-beam caret blinking at 1Hz, typed characters enter with a 2px rise; results filter with rows springing in/out (`layout` + `snap`), the top match becomes the selected row — an accent slab only where there is a cursor to follow (keyboard, fine pointer); on a phone (coarse pointer) the matched letters carry it and the top row shows the enter chevron (drawer B, 2026-11-12); Enter presses and lifts the row. Hangul initial-consonant (초성) matching. In the drawer the bar is a plain field on the paper and the hits are the drawer's own rows (nothing to refract, no panel). Reduced motion: no rise, rows appear. |
| **Chart** | bars rise left→right with a 30ms stagger on `morph` the first time they become visible (per session); hover/press a bar → glass tooltip bubble anchored to the bar, sliding between bars and counting values in tabular numbers. |
| **Counters** | numbers that change roll (odometer, 35ms/digit) only when the value actually changed since last visit; first paint shows the final value. |

## 4. Pointer & input

- Touch first. Targets ≥44×44. On fine pointers (iPad/desktop) an adaptive pointer: 22px translucent `#8E8E93 @45%` circle that **snaps (magnetism)** into the hovered control and becomes its highlight shape (rounded rect of the control, `snap` spring), becomes an I-beam over text fields, shrinks 10% on press. Hidden on touch (`(pointer: coarse)`).
- Keyboard: every control focusable, visible focus ring (accent 2px, offset 2px), Esc closes overlays, arrow keys on segmented/tab bar.
- Haptics (Android `navigator.vibrate`): 8ms on toggles/selection, `[8,40,8]` on error. iOS has none — never rely on it.

## 5. Dynamic Island (agent status)

The island is the agent's presence (opaque black SDF/CSS, never glass):
- **idle**: compact pill 126×37.
- **thinking / working**: stretches wider; left = agent avatar blob, right = live waveform (5 bars, amplitude from the stream's token rate); status text swaps in with the content-swap rule ("날씨 보는 중", "카카오톡 읽는 중").
- **tool done**: briefly shows a drawn checkmark (accent) then returns.
- **call**: the pill shows the avatar, the timer `00:42` (tabular) and five level dots (round 4 px dots at rest, never
  dashes). A tap grows it into the call card (the call screen is the island grown to the full device). A long-press
  (500 ms) grows it in place on the same `morph` spring into avatar · name · "듣고 있어요 · 00:05" · 음소거 · 통화 종료,
  with no scrim; a tap outside, Escape or 4 s untouched folds it back on `morph`. Reduced motion: it opens and folds
  without the spring (a cut), the controls fading in as usual.
- **notification**: stretches down into a glass banner (see §3) and contracts back.

## 6. Screens and their choreography

Each screen fills the device; the wallpaper is always visible around glass. Screen-to-screen = the tab droplet moves (two-edge) while the content swaps (exit 120 → enter +60, never a full-route serialised wait). The wallpaper never moves (§0 Wallpaper).

1. **Launch / onboarding** — no splash, no fake progress. First paint = final layout. Hero: the agent character (R3F blob with soft subsurface look, idle breathing at 0.2Hz, follows pointer/gyro ±6°, a slow surface swell while it animates; in a call the voice ripples it and swells it slightly; the eyes ride the surface and never sink into it; reduced motion and low power: still) over the wallpaper; "나만의 모시를 만나보세요" + one primary capsule "시작하기". Sign-up is a sheet that morphs out of that button: handle, password, my name, Pickle name; the button becomes loader→check on server confirm, then the sheet contracts into the top bar avatar (shared element) and the chat screen arrives.
2. **Chat (기본 채팅)** — top bar: menu circle (left), avatar + name as text on the scroll edge (centre, no capsule; tap → agent profile sheet, which also opens 친구 초대); nothing on the right. Glass is 3 shapes: the menu circle, the composer and the tab bar. Messages (chat B, 2026-11-12, user pick; was "assistant text on paper cards"): user bubbles accent-free (neutral fill); **the assistant speaks in plain text on the canvas, no bubble, and only its records (cards) are paper** — one paper per turn at most. Each assistant turn opens with its **turn head**: the agent's face (22 px; breathing only while it works, §8.11) and one line — the wait status (§8.4), then the tool status, then the folded line "자료 3개 보기 · 외교부, 네이버 뉴스 ⌄" or "N단계 · 1분 33초 ⌄" (§8.5). Friend threads follow the same rule; there the avatar + name beside each row say who speaks. Briefing cards: the rows are the buttons (§8.7). Tool activity is that same line (running ring + the real tool's words → the folded summary), and the read-only records (results, weather, a messenger room it read) fold behind it so the answer comes right after the head, also while it streams. Approval cards (two buttons, approve = primary; loader→check with device-key signature). Credential request card (inline secure form as one grouped field, the brand mark in the head, the promise said once under the password "이 기기에서 암호화돼요. 깽이도 볼 수 없어요.", keep-for as a sentence with a menu that grows out of "바꾸기"; "저장하고 이어서 하기" → loader → check on the server's 201, the card morphs into a "저장됨 · 7일" pill and the continue reply is sent). The "새 메시지" capsule is opaque paper and rises on `morph` only when something arrived below. Streaming text appears by line with a 2px rise (no per-character typewriter). Composer = glass capsule (+ attach, field, mic, call circle with a waveform glyph — talking with the agent, not the phone of the call cards); focusing grows it (morph) and lifts above the keyboard (`visualViewport`); send button appears by morphing out of the mic, and while there is something to send the call circle folds to width 0 on `morph` (back when the field is cleared); the buttons rest on the last line. Reduced motion: the head's face is still, the folds and the capsule are instant (every duration is a token), the line rise is off.
3. **Drawer** — slides from left on `camera` while the chat card scales to .94 and dims (depth), edge-swipe to open/close with direct manipulation; items: 기본 채팅/친구/둘러보기/보관함/나의 모시, search (Spotlight), "추가 대화" threads (call/task/friend icons), archive toggle.
4. **Explore (둘러보기)** (explore B, 2026-11-12, user pick) — large title collapses into the top bar on scroll (scroll edge effect). Category rail: words (추천 · 전체 · 혜택 …, no plates or hues), each a 44 px target; the selected word sits on the neutral droplet (40 px), which travels by two edges (§3) and gathers to the new word's width, and the word's weight changes as it lands (`snap`). Changing category is a directional content swap (§3, opacity + transform). 추천 = "깽이의 제안" signed with the agent's face + two first tries + "맡길 수 있는 일 전체 N개" (the real list length), which moves the droplet to 전체 and scrolls the rail back under the bar; 전체 lists every template. Rows lead with the title (two-line description, a real service's app icon or a bare glyph, no tile, no per-row accent; "N명이 맡겼어요" only for a real count). A row morphs into the pre-delegation sheet (§8.9). Reduced motion: the droplet jumps, the swap is instant, the sheet appears in place.
5. **Archive (보관함)** — segmented control 문서 | 사진·파일 (two-edge thumb, content swap); document cards (doc / dashboard / checklist, led by the title — no kind plate) open as sheets morphing from the card; dashboard artifacts render widgets with the chart rule; media grid with upload FAB (+) that morphs into the picker sheet — the FAB joins only once there is a file (the empty panel's one button opens the same picker). Empty state copy from the real app.
6. **Profile (나의 모시)** — one list grammar (my-mosi B, 2026-11-12, user pick): the agent row first (face, name, the persona's first sentence), then the server's sections (ui.profile.sections), each a title, a group and a footer, with no icon column — 사용량 (the quota row: % rolls, the bar fills on `morph`; the tickets row "기본 3장 · 프리미엄 0장" → sheet that morphs out of it: use a ticket → loader→check → the bar drains to 0 with a spring; the 7-day history is the footer line while empty and a bar-chart row with tooltip once there is history), 내 계정 (name · @handle, 내 전화번호), 깽이 (앱 연결, 예약된 일, 친구, 정보 공개 범위), 개인 정보와 보안 (저장된 로그인, 결제 수단, 접근 기록, 개인 정보 보호 → privacy explainer sheet: the shortcuts are text links under the answers, "자세히 보기" opens in place with the enclave measurement and the encryption steps), 앱 사용 (알림 설정, 화면 및 디자인). The centre of the top bar is empty until the large title collapses into it (§8.17). Each row pushes a detail screen with a horizontal `camera` slide where the title morphs from the row label into the large title (shared element). Agent settings: the colour is saved the moment it is picked (rolled back with a banner if refused, §8.13); name and persona wait for 저장하기. Reduced motion: % and the bar jump, the sheet and the disclosure are instant.
7. **Connections (앱 연결)** — messengers grouped by where they're used (일상: KakaoTalk, Instagram, LINE, Telegram, Discord · 업무: Slack, Teams, Webex), the person's own bots folded into one 고급 row (chevron turns on `snap`, bot rows rise in staggered, leave in EXIT). Each row shows the real app icon and morphs into its connect sheet: the title reads from the leading edge with the live status pill under it (no icon plate), the credential form comes first (encrypted on device; the sealing sentence is the secret field's own hint), then two summary rows, 할 수 있는 일 and 로그인 정보 보관, that open in place (height on `morph`, content fades in after it, chevron turns on `snap`). KakaoTalk shows the passcode in a large tabular display with a countdown ring while the server waits for the phone confirmation; status pill morphs connecting → connected (check draws). Reduced motion: the rows open and close at once, the chevrons jump.
8. **Vault (저장된 로그인 · 결제 수단 · 접근 기록)** — one inset list group per saved login: app icon + masked account, a 보관 기간 row whose value carries the expiry countdown and expands into the keep-for segmented (1시간/1일/7일/30일/계속; height on `morph`, content fades in after it, chevron turns on `snap`), 마지막 사용, and a red-text 이 로그인 지우기 row with the hold / two-tap confirm, after which the group leaves on EXIT and the groups below close up (`layout` position + `morph`). The access log is date-grouped row lists, not a rail timeline: app icon, service + action, actor · purpose, the time as the trailing value, and a quiet third line only for a refusal / failure or "이 기기의 키로 확인했어요" on device-signed rows (no badges, no "완료" pills). The large title follows the segment. Reduced motion: the row opens and closes at once, the chevron jumps, a deleted group is simply gone, the empty page doesn't rise.
9. **Friends (친구)** — friend list whose last row 친구 초대하기 grows the one invite sheet (chat, 친구 and 둘러보기 open the same sheet; share first, copy second), pending requests, friend's shared Pickle conversation (two agents + two humans, distinct bubble authors), block.
10. **Call (통화)** — tapping the call circle: the composer's call button stretches into the Dynamic Island which expands into the call card (avatar blob reacting to voice amplitude, the only meter on the card, with the name and status as its caption right under it; the timer stays on the island; mute, speaker, end); speech-to-text (Web Speech API) → agent (voice mode) → speech synthesis; transcript lines rise in. Mute (음소거) is private at once: words still being heard are dropped, not sent, and their line leaves the transcript; nothing reaches the agent until unmute, which listens afresh. A line typed in 글자로 말하기 joins the transcript as the person's line, as a spoken one does, right before its reply. When nothing will answer a line a running turn took, its "하던 일에 이어서 전했어요" note leaves the same way and the lines above settle into its place on the same spring; if this device shows the thread's error, the error reads in its place instead.
11. **Schedules (예약된 일)** — list of recurring tasks (모닝콜, 출석체크, 브리핑) with toggles (Focus-style lens knob).
12. **Settings: 알림 / 정보 공개 범위 / 화면 및 디자인** (settings B, 2026-11-12) — toggles (§3 Toggle); a row's subtitle that depends on its toggle swaps with it (§3 Content swap: what a friend's 모시 sees). Turning 보내기 전에 묻기 OFF asks in place, never in a sheet: its group grows (§3 Morph, `layout` on `morph`, transform only, radius corrected; what sits below moves with it) and "이제 깽이가 묻지 않고 보내요 · 취소 | 끄기" comes in by content swap at +60ms — a two-step tap in the same place (§8.6). The switch stays on until 끄기 (Toggle `onRequest`), 취소 / Escape fold it back the same way; ON is one tap. 알림 설정's device card leaves with the exit fade while the groups below move up (layout position). Theme is a choice list with one checkmark (system/light/dark; live theme morph via View Transition 200ms root crossfade is the ONE allowed crossfade — it is a material change, not a state swap), reduce motion/transparency overrides (segmented, thumb spring), text size slider (rubber band) on one paper with its preview. Reduced motion: the grow, the fold and the card's exit are instant.

## 7. Performance & accessibility budget

- First paint ≤ 1 frame after JS boot with final layout; the wallpaper is static CSS in the first-load chunk (no canvas, no lazy chunk). The only WebGL left (the AgentBlob character) loads after idle; skip WebGL on reduced motion, Save-Data, `deviceMemory<2`, software GL; frame watchdog (median of first 30 frames > 28ms → stop animating, keep last frame); the character always draws with MSAA (its silhouette and eyes are mesh edges and stair-step without it), at DPR ≤ 1.5 below 160 px (the agent sheet's 120 px) and DPR ≤ 2 from 160 px (call and onboarding 208 px); pause on `visibilitychange`.
- Never `will-change` on anything that gets scaled with text inside. Only on the droplet, island, pointer.
- ≤3 backdrop-filters on screen.
- Reduced motion: springs → 1ms or `fade`, no blur in/out, no loops (spinner allowed while in flight), no parallax, no 3D idle.
- Contrast 4.5:1 body, 3:1 large; never colour alone (status pills carry an icon + text).
- Screen reader: live region for streamed assistant text (polite, per finished sentence), tool chips announced on state change, buttons are `<button>`, sheets are `role="dialog"` with focus trap and return focus.

## 8. Amendments from the 60fps.design re-crawl (2026-11-11) — these override §0–§7

Source: `docs/research/60fps-pickle-per-page.md` §0 (top 15), §3-0 (state vocabulary), §7-1. The spring table (§2) is
unchanged — the 32 snippets' component springs (t90 116–241ms, ζ .82–.94) bracket our roles; avoid >3% overshoot (N023).

1. **One accent per screen.** Only the screen's primary action uses `--accent` (plus on/active/selected states). Invite,
   call, FAB, list actions are neutral; no coloured glows anywhere.
2. **Screen-to-screen transitions:** the droplet moves (two-edge); the old page is removed at once (no exit, no blur);
   the new page enters with opacity 180ms linear + y 6px on `camera`, the opacity timed from the tap (every frame reads
   the clock, floor .12), so a slow first render or late frames never stretch it. The blur content-swap (§3) is only
   for containers ≤ 25% of the viewport (buttons, chips, island, cards' inner content, segmented panels). Page-sized
   `filter: blur()` animation is forbidden. Detail push/pop keeps the horizontal camera slide + shared title.
   **Returns never re-enter (2026-11-12, user-rejected):** content that was on screen before a window opened is
   complete — height > 0, opacity 1 — on the very first frame the window starts closing, and on every frame after.
   This covers: popping a pushed screen (the page underneath jumps to opacity 1; only its 24 px parallax slides back,
   the leaving page fades out in 140 ms ease-out), a committed back swipe, a sheet closing (its source element is
   shown again on the first close frame; the sheet folds toward it on `snap` while panel + scrim dissolve in 160 ms
   ease-out, the content underneath takes taps from that frame, and the sheet unmounts once invisible, so an emptied
   shell never sits on the source while a spring settles; the same fade ends every other close: ×, scrim, Esc,
   slide-down, drag-dismiss), the drawer closing (on `snap`, not `camera`: card back and undimmed within ~160 ms, the
   dim stops taking taps at once), and switching back to a tab already visited (no entrance: the 180 ms opacity + 6 px
   rise plays only on a tab's first visit). The user saw a faded / emptied card for ~½ s after every close and
   rejected it. QA samples every frame for 1.2 s after the close in Chrome and WebKit and fails on a single frame with
   opacity < 1 or zero height, or with any sheet / drawer surface above opacity .05 later than 200 ms after the close
   (foundation.spec "close").
3. **One agent-state vocabulary** shared by the Dynamic Island, composer, tool chips and screen-reader live region:
   `idle · listening · thinking · tool:<name> · streaming · awaiting_approval · done · error · offline · call`
   (table in research §3-0). **Idle is still** — no waveform, no pulsing dot. Level dots only show real values
   (mic input level, token rate, the call's voice); at rest they are round 4 px dots, never dashes. Text comes from the real tool name (`k_weather` → "날씨 보는 중"; unknown →
   "작업하는 중"); after 2 s in the same state append elapsed seconds ("12초"); after 15 s without events show
   "오래 걸리고 있어요 · 멈추기". `done` draws a check then returns to idle after 1.6 s.
4. **Generating:** the send button morphs into **Stop** (rounded square) while a turn runs (aborts the stream).
   First-token timeline: 0–150 ms nothing → 150 ms the turn head with a still one-line placeholder → 1 s status text
   (content swap) → 2 s elapsed time. The head is the one the answer keeps (chat B): the face stays where it is and
   the first line lands under it, so nothing is swapped out. When the reply finishes, the final message takes the
   live draft's place with no second entrance: the turn stays at opacity 1 across the swap (chat.spec samples every
   frame; it used to blink from 0 for ~150 ms). Reduced motion: the same steps, the face still.
   Press feedback and the optimistic user bubble render in the same frame as the tap (CSS class, not a React round-trip).
5. **Tool status** names the real tool in the turn head's one line (toolfold, 2026-11-15, user request "가능한 더보기
   눌러서 펼쳤을때 보이도록"): the face, a ring and "뉴스 찾는 중" ("외 2개" while others run). After `done` the same
   row becomes the folded summary — "자료 3개 보기 · 외교부, 네이버 뉴스 ⌄" when read-only records came back (results,
   weather, a messenger room it read), else "N단계 · 1분 33초 ⌄" (chat B: the face says who did it, no check glyph);
   the words change by content swap (§3), the row, face and chevron stay. Tapping it (Enter/Space) opens, in place
   under it, those records and then each step's source and time (height on `morph` with the edge clipped while it
   moves, chevron on `snap`, the line kept under the finger); the answer comes after the line, so it is never pushed
   below a stack of records. Never folded: approvals, credential and connection requests, briefing choices, the
   schedule switch, a sent message's receipt, artifacts. Open or folded is kept per message while the thread is on
   screen; a reload or reopening the thread starts folded. Reduced motion: the panel is instant.
6. **Approvals by risk:** low (reversible, e.g. schedule create) → do it + 5 s undo toast (§8.13); medium (sending a
   message to others) → full preview of exactly what will be sent + 보내기 / 취소; high (payment, deleting, calling a third
   party) → hold-to-confirm 1.2 s **and** an equivalent two-step tap in the same place (accessibility), said in words
   under the button ("길게 누르거나, 두 번 눌러 확인해요", phone B). A call card (phone B) leads with the full number at
   title2 and puts the agent's face before the words it will say. Device-key signing on approve in all tiers ("이 기기의
   키로 확인했어요").
7. **Briefing card** = item rows (a text-size glyph + one line), and the rows themselves are the buttons
   (empty-thread A, 2026-11-12; the chips that repeated them are gone). A `send` row posts its words as the person's
   reply at once (the bubble appears in the same frame); the picked row rests in `label-2` until its answer lands
   while the others stay live, and a row tapped during a running turn is steered into it. An `open` row navigates
   (chevron). Press = the list row's flat tint.
8. ~~**Chat tab bar minimises** (iOS 26 behaviour) to the current-tab circle while typing or after scrolling down;
   the composer takes the rest of the row; scrolling up or blurring the field restores it.~~
   **Removed (2026-11-12): the user rejected it.** On the user's device, scrolling left the bar half-collapsed and
   faded at the bottom-left, under the composer (a measured width went stale mid-morph). The focus/typing minimise is
   removed too: it shares the same morph, and iOS keyboard timing cannot be proven frame-by-frame in Playwright. The
   bottom chrome is static: the composer slot sits above a full-width tab bar that never changes size or position,
   on scroll, focus, typing or keyboard. QA asserts the bar rect is constant and never overlaps the composer while
   scrolling and focusing.
9. **Explore:** tapping a template morphs the row into a **pre-delegation sheet** (explore B: the title reads from the
   leading edge; what it does as numbered lines with their source; where the result lands; then, right above "맡기기"
   — the screen's only accent — only what is still missing, a connect / invite button on each, and one cost line
   "약 1분 · 한도 약 2% · 오늘 100% 남음") → loader → check on the server's 201 → the sheet contracts into the chat
   composer and sends. call-demo without a verified number: "인증하고 받아 보기" hands over to the phone sheet (one
   sheet at a time); once the server says the number is verified the pre-delegation sheet morphs back out of its row
   with "전화 받아 보기".
10. **Drawer** is conversation-first and the record (drawer B, 2026-11-12, user pick): search first (no agent head —
   the top bar already shows the face and name), then **"지금 하는 일"** — threads the server says are live (an
   approval waiting, a call, a meeting) pinned on top with the state as their subtitle, no badges; none → no section —
   then 기본 채팅, 친구 (not in the tab bar) and the "맡긴 일" threads (or "보관한 대화", a text switch): a 20 px glyph,
   the time on the title line, and the agent's last sentence in that thread as a two-line subtitle (masked by the
   server). A row that goes up to or down from "지금 하는 일" moves with the list's `layout` (position, `snap`), the
   same move as any reorder; nothing new animates. Tab destinations appear only as one compact icon row at the bottom
   (REA parity without duplicating the tab bar's role). Main card scales to .96 (not .94) to keep text crisp.
   Reduced motion: rows jump to their places.
11. **Character breathing:** period 3.2 s, scale amplitude ≤ 2%, stops when offscreen/hidden/10 s without input; still
   pose under reduced motion; poster first, R3F later.
12. **Onboarding:** two steps — (1) 아이디·비밀번호 (social OAuth needs app keys we don't have; keep the step shape so
   Kakao/Google can slot in later), (2) my name + Pickle name with a suggested default. Permissions (mic, location,
   notifications) are asked when first needed, never during sign-up. Onboarding B (2026-11-12, user pick): the
   sheets are undimmed (the shell stays inert behind them) and both steps share one sheet height (login and its
   reset views share another); when a sheet opens, **the hero character travels to a stage above the sheet** — the
   same element, translated and scaled 208 → 168 px on `morph` — while the headline fades on `fade`; closing plays
   it back, and after a successful sign-up the character stays on its stage while the page leaves. In step 2 the
   name being typed sits under the face (it changes in the same frame as the input, no animation) and the face also
   sits next to the name field. "이전 단계" lives in the sheet head's leading slot. The server's agent spec is the
   one character: before an account the device shows its own preview; after a login (or if saving the sign-up
   character fails) the character on the stage takes the account's colour the moment the server answers — a plain
   change, no animation — so the chat that takes over shows the same face. Reduced motion: the character and the
   headline jump; the steps swap without movement.
13. **Banners:** one at a time, queued; hold 1.5 s + 60 ms × characters (2–4 s); errors contract into a dot back into
   the island. A banner rests just below the top bar, never over it: the island's pill travels down on `morph` while
   it grows into the banner (leaving plays it back up); its text shows only once the box has nearly cleared the bar,
   so no text ever crosses the bar, and 뒤로 / 메뉴 and the title stay visible and usable. It never
   takes a tap meant for something else: a tap outside it dismisses it and still lands; swipe up dismisses it too. A
   resting mouse or pen pauses its hold (8 s at most in all); a resting finger never does. Reduced motion: it fades in
   and out in place; reduced transparency: a solid fill.
   Low-risk actions get a 5 s undo toast instead of a confirmation (schedules A, 2026-11-12). The toast is
   glass at the bottom, just above the composer / tab bar, never over the top bar's menu and title; 실행 취소 is a
   44 px target. It rises 16 → 0 px on `snap` while it fades in, leaves with the exit fade (y +8), swipe down dismisses
   it, and a touch, the pointer or focus pauses the hold until all of them have let go. When the composer grows or
   leaves, the toast follows it on `snap`; an open sheet or the call card covers it. Under the call card it is inert
   (Tab never reaches its 실행 취소), its 5 s keep running with no hold or extension, and a toast still in its time
   shows again as the card folds away. It shares the banner queue.
   Reduced motion: no rise and no travel, it appears, re-places and leaves in place.
14. **Empty states** each offer one real action (puts an example prompt into the composer and navigates there);
   empty chat shows the agent's still face, one sentence and 3 suggestions as one grouped list (empty-thread A): a tap
   puts the words in the composer and focuses it (edit, then send). The rows rise y 4 → 0 on `snap`, 30 ms apart, the
   first time only (no re-entrance on return); reduced motion: no rise.
15. **Settings** default to "시스템 따름"; the vault screen hides values immediately on `visibilitychange`.
16. **Idle cost:** idle screens run no rAF loop and no running Web Animation (QA checks
   `document.getAnimations().length === 0` and no rAF after 2 s idle — no exceptions since the wallpaper became static
   CSS on 2026-11-12).
17. **Top bar centre** (shared top-bar rule, 2026-11-12; slop RH-1, GL-1/2): never a capsule — plain text on the scroll
   edge, so the top bar's glass is only its circles. 채팅's root shows the agent (face 30 + name; tap → agent sheet,
   target ≥ 44 px, dims while pressed); every other root and every pushed screen leaves the centre empty at rest and
   never repeats the agent's name. When a large title scrolls under the bar its words come in as the compact title by
   the content swap (§3; exit 120 ms → enter on `morph`) and hand back at the top; a pushed screen's title still
   morphs from the row that opened it (`layoutId`). A large title whose words change in place (a segment title,
   `LargeTitle swap`, e.g. 저장된 로그인's 로그인 정보 ↔ 접근 기록) swaps them with the same content swap inside the heading — no
   remount — and from its first change the heading stops tracking layout, so its glyphs never stretch and nothing flies
   back from the row. Reduced motion: the words appear and leave at once.
