# Mobile foundation — guide for screen builders

React 19 + Vite PWA. Build every screen from the parts below. `docs/design/MOTION-SPEC.md` is binding — its §8
(60fps re-crawl amendments) overrides §0–§7. This file is the API reference (FOUNDATION-NEXT.md is merged in here). Try every primitive live at **`/?gallery=1`**, which runs inside the real shell and has theme,
reduced-motion, transparency and text-size switches.

```
src/
  main.tsx, App.tsx      tier init → session bootstrap → <Shell>; ?gallery=1 → dev/Gallery (lazy)
  api/                   client · sse · events · endpoints · store (hooks + actions) · auth · defaults
  motion/                springs · tier · ContentSwap · useTwoEdge · usePress · rubberBand · haptics · breathing
  ui/                    primitives (below) + geometry · SendButton · ConfirmButton
  app/                   Shell · nav · NavStack(+navLayers, routeActive) · Screen · TopBar(+topBarStore) · TabBar(+useDropletLens)
                         agentState (+agentVocab) · DynamicIsland(+island) · AgentLive · BannerHost · Drawer
                         ChromePortal · device
  three/                 WallpaperHost + Wallpaper.css (first load, CSS only) · palette · AgentBlob (lazy R3F)
  screens/               placeholder tab roots (chat, explore, archive, profile) + registerScreens()
  styles/                tokens.css · base.css · glass.css
qa/foundation.spec.mjs   Playwright QA (screenshots → docs/qa/foundation/) · vite.qa.config.mjs (stub build)
qa/*.test.ts             bun unit tests (sse, hangul, api contract, agent state, route activity)
```

## Rules (do not break)

- **Springs only.** Motion roles: morph .45/.86 · press .25/.75 · snap .30/.90 · camera .60/1.0 · lead .28/.86 ·
  trail .42/.86 · fade .24/1.0. Overshoot ≤ 3 %. No bouncy easing and no `ease-in-out`. The one exception is the
  exit curve (120 ms) when content leaves.
- **Animate only transform and opacity.** Clip-path is allowed for shape morphs. Every animation must be
  interruptible: retarget the same MotionValue and its velocity carries over.
- **Press = lift and swell. Never shrink.** Glass swells ×1.06 (×1.12 for small circles), opaque surfaces ×1.03.
- **Morph, never crossfade.** When content changes, the old copy exits (blur 6, scale .96, 120 ms) and the new one
  enters 60 ms later (`ContentSwap`). The blur runs only in containers ≤ 25 % of the viewport (buttons, chips, island,
  card insides) — ContentSwap measures and drops it for bigger ones. **No page-sized `filter: blur()` animation.**
- **Glass is a lens.**
  - Tint 10–16 % white, a 1 px rim top-left with a counter-light bottom-right, contact shadow `0 10 30 @12%`.
  - Never put glass on glass.
  - At most 3 backdrop-filters on screen: top-bar group + bottom-chrome group + transient banner. Join the
    existing groups and never add another one.
- **Content is paper** (`Card`): opaque, never glass, and it never lifts. **Flat Paper** (DESIGN.md): paper casts no
  shadow — light separates by value (`#fff` on `#f5f5f7`), dark and increased contrast by the hairline
  `inset 0 0 0 1px var(--separator)`. A list on paper merges into it (one edge). Shadows belong to glass and to the
  control knobs (toggle, slider, segmented thumb) only.
- **Concentric radii, all tokens.** inner = outer − inset. A radius is a token or height / 2: CSS `var(--r-*)`
  (`device 55 · sheet 38 · sheet-inner 28 · card 24 · group 20 · banner 36 · tabbar 34 · composer/droplet 28 ·
  control 22 · field 14 · tile 12 · plate 8 · capsule 999`), or `calc(var(--r-outer) - <inset>px)`; TSX `R.*`,
  `concentric()`, `capsule(h)` from `ui/geometry.ts`. Only glyph geometry and data marks keep small literals, with a
  comment.
- **Colour.**
  - ONE accent, only for on / active / selected and **the screen's one primary action** (§8.1). `--accent` #0A84FF
    is the tint (selection marks, toggles, the active tab, glyph-only circles); a blue surface that carries text uses
    `--accent-fill` #0071E3 (white 4.7:1, both themes); blue text uses `--accent-text`. Invite, call, FAB, list
    actions, secondary capsules/circles: `tone="neutral"` (fill + label in every state). No coloured glows, no lifts.
  - Other text tokens: `--placeholder` (≈3:1 hint, fields always keep a visible label), `--danger-on-fill` (red
    label on `--danger-fill`, ≥4.5:1), `--thumb-raised` (segmented thumb), `--accent-on-droplet` (the active tab label on its droplet: light #005BB8 on
    the grey pill, dark #8CC4FF; `qa/foundation.spec` measures the rendered pill with the page's top and bottom and the
    top/¼/mid/¾/bottom of a list and of a thread with cards under the bar, and fails when the worst case is below
    4.5:1, or when the droplet's luminance is within ×1.1 of the bar's).
  - The Dynamic Island is the only pure black. Labels use `--label` #1D1D1F and `--label-2` #6E6E73.
  - `--caution` (투자 only, DD 1935 §0-3): the 경계 signal and worsening figures, light #9A5B00 (5.43:1 on paper),
    dark #FFB340. 투자 has no up/down colour; `--danger` there means risk (위험, 실제 주문), never a falling price.
- **Never use:** emoji, particle bursts, neon glows, gradients on chrome, or `will-change` on scaled text.
- **Accessibility and type.**
  - Targets ≥ 44 px and inputs ≥ 16 px.
  - Hangul uses `keep-all` (global). Numbers use `.tnum`.
  - Copy breaks in one place: a copy slot takes `.t-copy` and its text goes through `copy()` (Line breaks).
  - Use `rem` for type so it follows the in-app text scale (`--text-scale` on `<html>`).
- **Twins come for free** if you use tokens and primitives: reduced motion, reduced transparency, increased contrast,
  dark, forced colours. Never hard-code colours.
- **Never claim success before the server does.** Use `Button action` and `island.done()` only on a server event.
- **Idle cost (§8.16).** An idle screen runs no rAF loop and no running Web Animation: 2 s after the last input
  `document.getAnimations().length === 0`, and no rAF at all (the wallpaper is static CSS). Loops only
  while something real is happening (a request in flight, a live level, a drag). Idle is still — no pulsing dots.

## Motion (`src/motion`)

```ts
import { SPRING, springTo, t, ContentSwap, SwapText } from "../motion/…";
<motion.div animate={{ x }} transition={t("morph")} />           // reduced-motion aware (instant when reduced)
springTo(mv, 120, "snap", { velocity, onComplete })               // MotionValue; caps overshoot ≤3 %, keeps velocity
SPRING.camera                                                     // raw framer transition object
cssTransition("opacity", "fade")                                  // CSS: var(--dur-fade) var(--ease-fade)
```

| helper | use |
|---|---|
| `ContentSwap({ swapKey, children, display?: "inline"\|"block", direction?: -1\|0\|1, as? })` | Changes the content of a stable container. Blur only when the container is ≤ 25 % of the viewport. `direction` switches to panel mode: a 16 px travel, no scale, no blur. The leaving copy is `inert` and aria-hidden. |
| `useBreathing(ref, enabled)` → boolean · `breathScale(t)` · `noteInput()` | Character breathing (§8.11): 3.2 s, scale 1 → 1.02, only while on screen + visible + within 10 s of input; still under reduced motion. `useOnScreen(ref)` is exported too. |
| `SwapText({ text })` | Text-only shorthand for `ContentSwap`. |
| `useTwoEdge(target: {left,right} \| null)` → `{ left, right, width, center, rim, hold(edges), settle(edges, v?) }` | Selection indicators with lead/trail edges. The first placement is immediate. |
| `usePress({ kind: "glass"\|"opaque", scale? })` → `{ scale, rimBoost, bind }` | Lift and swell on pointer down. |
| `rubberBand(d, 60)`, `rubberClamp(v, min, max)`, `createVelocityTracker()`, `project(v, vel)` | Drag physics. Velocity comes from an 80 ms least-squares window; projection looks 180 ms ahead. |
| `haptic("selection"\|"toggle"\|"impact"\|"success"\|"error")` | Android only. Fires only after user activation. Never rely on it. |
| `useTier()` / `useTierValue("reduceMotion")` / `setDisplayPrefs({ theme, reduceMotion, reduceTransparency, textScale })` | Combines OS and in-app display preferences. They are written to `<html data-theme / data-motion / data-transparency / data-contrast / data-effects>`. A theme change runs through a View Transition, the one allowed crossfade. `updateSettings()` in the store also persists them to the server. |

## Shell, navigation, screens

The Shell provides:

- the device frame: 402×874 r55 on desktop, full-bleed on a phone with `env(safe-area-*)`
- the wallpaper, top bar, bottom chrome (tab bar plus a composer slot), Dynamic Island, banners, sheets, drawer and
  adaptive pointer.
- `<Shell content={…} chrome={false}>` (onboarding): no top bar, no bottom chrome, no drawer or edge gestures; the
  wallpaper, island, live region, banners, sheets and device frame stay.

**Register screens:**

```ts
import { registerTabRoot, registerScreen, lazyScreen, nav, type ScreenProps } from "../app/nav";
registerTabRoot("explore", ExploreScreen);                 // replaces the placeholder (screens/index.ts)
registerScreen("settings.display", DisplayScreen);         // detail screens, pushed by name
registerScreen("call", lazyScreen(() => import("./call/CallScreen").then((m) => m.CallScreen)));  // own chunk
nav.push("settings.display", { from: "profile" }, { title: "화면 및 디자인", titleLayoutId: "row-display" });
nav.pop(); nav.popToRoot(); nav.setTab("profile"); nav.openDrawer(); nav.closeDrawer();
nav.compose("이번 주 할 일을 정리해 줘", threadId?);         // §8.14: go to the chat (or that thread), fill the draft, focus
setComposeHandler((text, threadId?) => …);                 // chat screens: how to fill + focus (queued until registered)
const tab = useNav((s) => s.tab);
```

**Lazy screens** (route-level code splitting; see "Performance"): anything not on screen at first paint — tab roots
other than chat, detail screens, the call UI, viewers — registers as `lazyScreen(() => import(…).then((m) => m.X))`.
It is a plain component (no Suspense): it renders the screen synchronously once its chunk is in, nothing before.
`nav.push` / `nav.setTab` wait for a lazy route's chunk before starting the transition, so a page never slides in
empty (a tab whose root is replaced — the gallery — never waits). Every `lazyScreen()` is prefetched in parallel once
startup is over, so the wait is normally zero. `lazyScreen<Props>()` also works for a heavy non-route component
(an overlay, a viewer sheet). Keep the drawer content eager: the drawer opens under the finger. A screen module that
anything imports statically stays in the entry, whatever the register file says.

**Navigation behaviour:**

- Tabs stay mounted once visited, so their state is kept.
- Switching tabs (§8.2): the droplet travels; the old page is removed at once (no exit, no blur); the new page enters
  with opacity 180 ms linear + y 6 px on `camera` (it reads > .2 at 50 ms — QA-checked); the wallpaper does not move. A tab visited for the first time enters the same way.
- Push: the detail arrives from 40 px while the list recedes. Pop reverses this.
- Back: swipe from the left edge (20 px). The detail follows the finger 1:1, and on release the swipe is projected
  forward. At a tab root, the same edge swipe opens the drawer instead.
- Tapping the active tab pops to its root.

**Screen template** (it clears the bars, applies the scroll edge effect and remembers scroll per route):

```tsx
export function ExploreScreen({ route }: ScreenProps) {
  useTopBarRight({ label: "초대", onPress: (el) => presentSheet({ source: el, title: "초대", render: … }) });
  return (
    <Screen routeKey={route.key} /* composer — leaves room for a composer above the tab bar */>
      <LargeTitle title="둘러보기" subtitle="요즘 많이 맡긴 일" layoutId={route.titleLayoutId} />
      …paper content (Card / List)…
    </Screen>
  );
}
```

- **Scroll edge effect** (every `<Screen>`; don't add your own): content thins out as it passes under the bars. A
  mask on the scroller makes it fully transparent above the top bar's bottom edge − 4 px and opaque at the resting
  content line. Once the list has scrolled 24 px, a masked blur strip fades in over it. The strip is a sibling of the
  scroller, so it sits above the content and below the top bar. Nothing reads at full contrast behind or between the
  capsules. The mask does the hiding because WebKit's backdrop-filter does not see into a composited scroller (there
  the strip only blurs the wallpaper). Reduced transparency / increased contrast: no mask; opaque `--bg` bands with a
  hairline instead. At the top the band reaches 6 px below the bar. At the bottom the floor runs from the screen's
  bottom to 6 px above the composer (or the tab bar), so nothing shows in the gap between them, beside them or below
  the tab bar. The floor follows the scroller's `--edge-bottom`, which a chat screen sets as its composer grows. The
  scroller is isolated in these modes, as the mask made it, so a z-indexed row never rises over a band. A custom
  scroller under the bars must do the same, so use `<Screen>`.
- **`LargeTitle`** hands its words to the top bar's centre capsule once it scrolls under the bar (a content swap,
  and the capsule width morphs), and hands them back at the top. To morph a pushed screen's title out of the row
  that opened it, put the same `layoutId` on the row (`ListRow layoutId`) and pass it as `titleLayoutId` when you
  push.
- **Top bar API** (`app/topBarStore.ts`):
  - `useTopBarRight({ label?, icon?, ariaLabel?, tone?, onPress?(el) } | null)` sets the trailing capsule.
    - `tone: "danger"` draws the label in `--danger` (투자's 실제 주문).
    - A new label or tone re-shapes the same capsule (FB4-1): the width springs to the new words' (`morph`, measured on a hidden copy), the colour eases, and the words swap.
    - Without `onPress` it is a status, not a button (DD 2008 §1): no press, cursor, role or tabindex. Assistive tech reads `ariaLabel`, and the words are hidden from it.
  - `useTopBarCenter((el) => …)` makes the avatar capsule tappable (for example, to open the agent profile sheet).
  - The left circle is the menu, or a back chevron when the tab has a pushed screen.
- **Composer:** don't add your own floating bar. Portal into the bottom chrome group so it shares that group's
  blur, and use `SendButton` as its trailing control:

  ```tsx
  <ChromePortal group="bottom">
    <Glass blur="group" text lens radius={28} className="composer">
      …field…
      <SendButton mode={running ? "stop" : text ? "send" : "mic"} onSend={send} onStop={() => stopTurn(threadId)} onMic={listen} />
    </Glass>
  </ChromePortal>
  ```

  Use `<Screen composer>` so the content clears it. `--kb` holds the keyboard height (visualViewport). Position
  with `bottom: calc(… + var(--kb))`.
- **Bottom chrome is static** (§8.8, amended 2026-11-12): the slot sits above a full-width tab bar that never
  changes size or position: not on scroll, focus, typing or the keyboard. The tab bar minimise (scroll and focus)
  was **removed because the user rejected it**: on their phone, scrolling left the bar half-collapsed under the
  composer. `app/tabBarStore.ts` and the whole minimise API are deleted; don't bring them back.
- **Returns are complete on frame one** (§8.2, 2026-11-12): whatever was on screen before a window opened is shown at
  opacity 1 on the first frame it starts closing. That covers a pop or committed back swipe (the page underneath jumps
  to 1 and only its 24 px parallax slides back), every sheet close — ×, scrim, Esc, slide-down, drag-dismiss,
  `presentSheet` (`Sheet` shows its source again at once, takes no more taps, and dissolves in 160 ms while folding
  toward it on `snap`; it unmounts as soon as it is invisible, so no surface shows later than ~200 ms) — the drawer
  (closes on `snap`; the dim stops taking taps at once), and a switch back to a visited tab (no entrance; the 180 ms
  fade + 6 px rise is for a tab's first visit only). Screens must not add their own re-entrance either: no fade-in on
  remount or refocus, and no placeholder for data you already had. The user saw a blank card for ~½ s after every
  close and rejected it. Your own overlays (e.g. a card that morphs into the island) follow the same rule: fade the
  surface out within 200 ms of the close and unmount it; don't let a blank shape settle on top of content. QA:
  foundation.spec motion "close".
- **Shared chrome follows the visible route:** tabs and pushed-under screens stay mounted, so a screen's claims on
  the top bar (`LargeTitle`'s compact title, `useTopBarRight`, `useTopBarCenter`) apply only while it is the top of
  the active tab, and come back when it is shown again. Your own claims on shared chrome should do the same with
  `useRouteActiveSource()` from `app/routeActive.ts` — a stable `{ get(), subscribe() }`, so a tab switch does not
  re-render your screen (a whole-screen re-render in the tab-switch frame made WebKit miss the §8.2 timing).
  `useRouteActive()` is the boolean hook for a small component's own render. Both are true outside the nav stack.
- **Drawer:** `registerDrawerContent(({ close }) => <ThreadList onPick={…} />)` adds content under the
  server-driven destinations; `registerDrawerContent(C, { replaceDestinations: true })` hides that list (§8.10
  conversation-first content that renders its own compact destination row) and keeps only the agent head. The main
  card scales to .96 (§8.10).

## Controllers

**Agent state** (`app/agentState.ts`, §8.3) — ONE vocabulary shared by the Dynamic Island, the composer, tool chips
and the Shell's polite live region (`<AgentLive/>`): `idle · listening · thinking · tool:<name> · streaming ·
awaiting_approval · done · error · offline · call`. `sendMessage` / `decideApproval` / `stopTurn` /
`navigator.onLine` drive it; screens mostly read it.

```ts
const s = useAgentState();      // { kind, label, tool?, threadId?, elapsedS, slow, level }
agentState.set("listening");    // | "thinking" | "tool" ({ tool }) | "streaming" | "awaiting_approval" ({ label }) | "done" | "error" | "offline" | "call" | "idle"
agentState.level(0.4);          // real values only: mic input level (listening / call) or token rate (streaming)
agentState.pulse();             // an event arrived → resets the 15 s timer
setIslandTapHandler((s) => …);  // e.g. awaiting_approval → scroll to the card (stall → stop and error → retry are built in)
toolLabel("k_weather");         // "날씨 보는 중"; msg_read → "메시지 읽는 중" ("카카오톡 읽는 중" when the title names it); unknown → "작업하는 중"
toolSource(name) · stepsSummary(4, 12300) → "4단계 · 12초"   // tool chips
```

- **Hit area = the visible pill** (the clipped max-size box takes no pointers): idle takes none, busy states only the
  pill, the expanded call its controls — taps on the top bar below it never land on the island.
- **Idle is still**: 126×37, nothing moves. Busy states widen to fit the text (morph); the label comes from the real
  tool name, never a rotating phrase. Thinking shows its text after 1 s. After 2 s in one state `elapsedS` is set
  ("12초" in the island). After 15 s without events `slow` is set: "오래 걸리고 있어요 · 멈추기" (tap = stop; not an
  error). `done` draws a check, then idle after 1.6 s. `error`: a still red dot + "다시 시도할까요?" (tap = retry).
  `offline`: dashed circle + "오프라인". Level bars appear only for listening / streaming / call and their height IS
  the level (0 → flat). Turns running in another tab or a schedule show as thinking without the stall clock.
- Lower level (`app/island.ts`, same store): `island.thinking(threadId)`, `island.tool(name, title?)`,
  `island.tokens(n)`, `island.awaitingApproval(title)`, `island.done()`, `island.error()`, `island.idle()`,
  `island.event()`, `island.setHandlers({ stop, retry, open })`, `island.call({ name })`, `updateCall`,
  `toggleCallExpanded`, `endCall`. `island.working(label)` remains as a thin deprecated wrapper.

**Banners** (`island.banner`, §8.13) — one at a time, queued; they grow out of the island (black ink → glass):

```ts
island.banner({ icon: "card", title: "결제 승인이 필요해요", body: "쿠팡 · 32,400원", onPress, kind?: "info" | "error" | "undo",
                action?: { label, run() }, hold?, onExpire? });
island.errorBanner("인터넷 연결을 확인해 주세요.", "보내지 못했어요");   // role=alert; contracts into a red dot at the island
island.undo({ title: "모닝콜을 만들었어요", onUndo: () => api.undo() });  // 5 s, neutral "실행 취소" button (low-risk actions, §8.6)
island.dismissBanner(id);
island.clearBanners();          // drop the shown one and the queue (sign-out, reset, tests); no onExpire
```

- Hold = clamp(1.5 s + 60 ms × characters, 2–4 s) unless `hold` is given; touch, hover or focus pauses it and it
  resumes with the time that was left. Swipe up dismisses; a tap runs `onPress`. `tone: "error"` = `kind: "error"`.
- The top bar steps back while a banner is shown, so glass never sits on glass.
- The banner's content starts below the island (a 46 px band): the island — ours while busy, the hardware one on a
  phone — stays visible above the text, like an expanded Live Activity.

**Sheet** (`ui/Sheet.tsx`) morphs out of its source, and only one is open at a time.

```tsx
<Sheet open={open} onClose={() => setOpen(false)} source={buttonRef} title="티켓 사용" busy={pending}
       footer={<Button fullWidth action={use} onSuccess={() => setOpen(false)}>사용하기</Button>}>…</Sheet>
// or from anywhere:
const s = presentSheet({ source: el, title: "알림 설정", render: (s) => <Form onDone={s.close} />, footer?: (s) => … });
s.setBusy(true); s.close();
```

Sheet behaviour:

- Interaction:
  - Drag down on the grabber or header to dismiss. The body also drags when it doesn't scroll.
  - Esc, the backdrop and the close button also close it.
  - Focus is trapped inside and returned on close.
  - The shell becomes `inert` while the sheet is open.
  - `busy` refuses every way of closing.
- Morph and focus:
  - The source is hidden while the sheet is its continuation (`hideSource`).
  - Fields are focused only when they carry `autoFocus` or `data-autofocus`.
- Layout: the panel padding is 10 px, so inner radii are 28.
- Scroll edges: once the body scrolls, rows thin out over the 12 px under the head; while more is below, over the
  12 px at its end (above the footer). Each ramps over the 12 px of scroll next to its end (Screen's top edge), so the
  first row at the top and the last row at the end are never thinned. Reduced transparency keeps it (the sheet is
  opaque); increased contrast draws a hairline under the head and above the footer instead (none at a footer-less
  end). Don't pad the head or the footer instead: every sheet would grow.

## Primitives (`src/ui`) — props and states

| component | props (essentials) | states covered in the gallery |
|---|---|---|
| `Glass` | `as`, `variant: "regular"\|"clear"`, `text` (legible tint), `sheet` (opaque surface, no backdrop — any alpha without blur lets sharp text behind show through), `radius`, `interactive` (bool \| swell), `lens` (accepted, no effect since the CSS wallpaper), `blur: "own"\|"group"\|"none"`, `adaptive` (luminance veil), `rim` (MotionValue angle), `shadow` | regular / clear / text / pressed; reduced-transparency twin |
| `BlurGroup` | `name?` (`"top"`/`"bottom"` are the shell's), children use `<Glass blur="group">`; ONE backdrop-filter clipped to the union of members, placed again in the frame a member or the host resizes (a capsule joining the bar grows the host above its members) | gallery glass row |
| `Button` | `variant: capsule\|circle\|plain`, `tone: primary\|glass\|secondary\|neutral\|destructive`, `size: lg 52\|md 44\|sm 36`, `icon`, `action: () => Promise`, `state` (controlled), `onSuccess`, `onError`, `errorLabel` ("다시 시도하기"), `busyLabel`, `holdSuccess`, `fullWidth`, `disabled`, `ref`, `elevated` (marks a FAB; no shadow), `stop` (glyph → rounded square, label "멈추기"), `confirm: { label, holdMs = 1200, hint? }` (hold-to-confirm + two-step tap) | idle → loading (the capsule contracts into a ring) → success (a check draws) → idle \| error, every tone (neutral = never accent), stop, confirm, disabled |
| `SendButton` | `mode: "mic"\|"send"\|"stop"`, `onSend`, `onStop`, `onMic`, `disabled`, `disabledReason` — one 44 px circle: mic (neutral) ↔ arrow (accent fill) ↔ rounded-square stop (label fill); CSS `:active` press in the tap's frame | gallery "보내기 ↔ 멈추기" |
| `ConfirmButton` | `label`, `onConfirm: () => Promise`, `holdMs` (1200), `tone: primary\|destructive\|neutral`, `size`, `fullWidth` (true), `confirmLabel` ("한 번 더 누르면 실행돼요") — high-risk (§8.6): press-and-hold fills linearly (release → rewinds on snap) AND a two-step tap in the same place (second tap within 3 s); keyboard / screen readers use the two-step path | step two, holding |
| `Icon` | `name` (every protocol `IconName` + extras: `ICON_NAMES`), `size`, `weight` | grid of all |
| `SegmentedControl` / `SegmentedPanels` | `options [{value,label,icon?}]`, `value`, `onChange`, `label`, `role: tablist\|radiogroup`, `size`, `idBase` · panels: `value`, `order`, `idBase` | 2/3 segments, drag-scrub, sm, panels |
| `Toggle` | `checked`, `onChange`, `label`, `disabled` | on / off / disabled on / disabled off |
| `Slider` | `value`, `onChange`, `min`, `max`, `step`, `label`, `format`, `minIcon`, `maxIcon`, `showValue`, `onCommit`, `disabled` | live / disabled |
| `Chip`, `ChipGroup` | `label`, `icon`, `selected`, `onClick`, `size: md\|sm`, `disabled` | selected / unselected / sm / disabled |
| `List`, `ListRow`, `ListSection` | row: `icon`, `iconTint`, `leading` (any node in the 30×30 plate slot, e.g. a brand logo; decorative, wins over `icon`), `title`, `subtitle`, `detail`, `accessory`, `chevron`, `onClick`, `destructive`, `disabled`, `layoutId`; section: `title`, `footer`, `level` (heading h2 on a screen, 3 in a sheet) | chevron / toggle accessory / disabled / destructive |
| `Card`, `CardHeader`, `CardTile` | `padding` (18), `radius` (24) → tiles get the concentric radius; `onClick` makes it pressable (flat tint) | summary card |
| `ProgressBar` | `value 0..1`, `label`, `showValue`, `tone: accent\|label`, `height` | two tones |
| `Odometer` | `value`, `format`, `prefix`, `suffix` | digits roll (snap) |
| `BarChart` | `data [{label,value}]`, `id`, `ariaLabel`, `unit`, `selected`, `height`, `format` | selected bar moves |
| `Avatar` | `spec {hue, shape: blob\|round\|drop, eyes: dot\|oval\|smile}`, `size`, `breathing` (opt-in, default off — for the character on stage, not list / chrome avatars), `ring`, `label` | shapes / eyes / sizes |
| `AgentBlobLazy` | `size`, `spec`, `amplitude`, `label` — SVG poster first; the 3D chunk loads lazily only on capable GPUs. Its render loop runs only while on screen + visible and (within 10 s of input or a live `amplitude`); otherwise one still frame. Always MSAA (smooth edges); DPR ≤ 1.5 below 160 px, ≤ 2 from 160 px | 3D blob |
| `LargeTitle` | `title`, `subtitle`, `layoutId`, `accessory` | hand-off to the top bar |
| `TextField` | `label`, `value`, `onChange`, `type`, `error`, `hint`, `placeholder`, `variant: plain\|filled`, `disabled`, `onEnter`, `trailing`, `ref` | filled / error / hint / empty / disabled / filled-variant |
| `Spotlight<T>` | `items`, `getKey`, `getLabel`, `getSubtitle?`, `getIcon?`, `getKeywords?`, `onSelect`, `placeholder`, `emptyText`, `recent?`, `limit` — Hangul 초성 matching (`lib/hangul.ts`) | ㅎㅁ → 화면 및 디자인 |
| `EmptyState` | `icon` (a bare glyph, no plate), `title`, `body?`, `action?` | with action |
| `Text` | `copy(node, { sentences, clamp })`, `<Sentences text sentences? clamp?>`, `tied(text, { clamp })`, `glued(text)` (flowing text), `sentencesOf(text)`, `emWidth(text)` (an upper bound in em); class `.t-copy` on the slot (Line breaks) | 줄바꿈: the old lines in every foundation slot |
| `AdaptivePointer` | — (fine pointers only, its own chunk — phones never load it; nothing renders and the system cursor stays until a real mouse moves: ≥ 4 moves, ≤ 100 ms apart, ≥ 6 px, no press between — so no dot at first paint, on touch or from automated clicks; hides after 4 s still; snaps into controls ≤ 160×96, I-beam over inputs; `data-pointer="none"` opts out) | desktop screenshot |
| `Invest` (투자 parts, DD 1935 §0-4, §1) | `SignalMark {signal}` (quant's 16×16 shape, currentColor, aria-hidden) · `SignalLabel {signal}` (mark + 위험/경계/정상/확인 불가 in the signal's colour) · `InvestNum {value}` (a string from `@pickle/quant`'s formatter, tabular; missing → the 확인 불가 mark + words) · `IvRows` / `IvRow {label, value}` (subhead, word `--label-2` left, value right, hairline + 12 above, 6 between) · `IvFoot` (footnote) · `IvHero` (28/600) · `IvDisclaimer` (quant's `DISCLAIMER`, word for word) · `ModeWord {mode}` (모의 `--label-2` / 실제 `--danger`, 13/600). No screen formats a number itself | gallery 투자 · 신호 · 행 (with the capsule switch 초대 / 모의 / 실제) |
| `geometry` | `concentric(outer, inset)`, `capsule(h)`, `R` (device 55, sheet 38/28, card 24, tile 12, group 20, tabbar 34, droplet 28, composer 28, control 22, field 14), `MIN_TARGET` | — |

## Line breaks (`src/ui/Text.tsx`)

Korean copy breaks in one place, not screen by screen. A copy slot (an element holding sentences people read) takes
the class `.t-copy` (text-wrap: pretty: no one-word last line), and its text goes through `copy(node)` (a string becomes
`<Sentences text>`; a node you built is left as it is):

- **Sentences.** In a text of two sentences or more, each sentence is an inline-block (`.t-s`, pretty inside too), so a
  sentence that fits on one line never starts at the end of a line and wraps mid-way: it moves down whole. A text
  holding a character WebKit sizes apart from how it draws it ("#️⃣", "‼️": Flowing text, below) takes no sentence
  blocks, and no tie from the word holding it to the line's end: the box would move what follows it.
- **Ties** (`.t-tie`, an inline-block). A word is cut after each "·" and before a "(" that follows Hangul (after a
  Latin letter or digit the browser has no break either: "presentSheet()"); the pieces holding "(", "·" or a ")" with
  more after it are tied, with a `<wbr>` between pieces ("공연<wbr>(연극·<wbr>뮤지컬·<wbr>콘서트)을"). A line may end after "·" or
  before "(", never on "(", and never starts with ")" or "·": WebKit's text-wrap: pretty picks both, and a nbsp alone
  does not stop it. The `<wbr>` adds no break: a box's edges are breaks already, and the lines are the same without
  it (22,179 blocks of app copy and replies at 150–430, both engines, 2026-11-18). It is from when ties were nowrap
  inlines, between which WebKit never breaks; an empty box in its place moves WebKit's pretty (184 of 6,204 blocks of
  app copy). A "·" between spaces rides on the word before it over a nbsp
  ("01***&nbsp;·"), so the dot ends its line; a "·" after a line break ("준비물\n· 물") opens its line and stays. The
  pieces are boxes, not nowrap inlines: with four nowrap inlines in a
  line WebKit's pretty laid "찾아" on two lines at once (drawn twice) and left "알려줘요." alone (233 and 263 px); every edge
  of a piece is a space or a `<wbr>` already, so boxes add no break. The box takes its parent's white space, so in copy
  it wraps inside: it is as wide as its text, so a piece that fits a line is one line and moves down whole when the
  line has no room left, and a piece wider than the whole line (a long amount in a narrow cell) wraps inside instead
  of running out of its block (measured at every position, 60–360 px, both engines: 0 wrapped while fitting, 0
  overflowed). A box takes no underline from its parent: tied copy does not go inside a link or a one-line ellipsis.
- **Quotes** tie the same way: a word holding a quote or corner bracket with letters on its inner side is one box
  ("“내", "줘”처럼", "‘테스트’예요"). Under keep-all both engines still break between ” ’ and the Hangul after it
  ("기억해 줘” / 처럼 말하면", the agent's memory footer at WebKit 320), and WebKit also between “ ‘ and the Hangul after
  it ("없어요. “ / 내 생일은").
- **Numbers.** A number and the unit or counter after it ride together over a nbsp in one box ("3.3만&nbsp;원",
  "회비 3만&nbsp;원은", "10&nbsp;km를"): keep-all breaks at that space ("3만 / 원은", a room card at 430). The unit's word
  may go on only with a particle or punctuation, so "1 일정" and "3 대학로" stay apart. A piece holding a number with a
  separator inside, or with % ° ℃ and letters after it, is one box too ("3.3만", "1,200,000원이고", "12:30에",
  "11:39–11:51", "2026-11-17이고", "3%이고"). Under keep-all WebKit breaks inside a number at the point, comma, colon,
  slash and en dash ("월 최대 3. / 3만 원이"), and Chrome after a hyphen or en dash and between % and the Hangul after it
  ("3.3% / 이고"), with room on the line for the whole word. No engine breaks at "~". Runs over 16 characters are left
  alone.
- **Domains.** A word holding a domain (a letter or digit, a point, two Latin letters or more) is one box, path,
  particle and all, at any length: "microsoft.com/devicelogin에", "example.co.kr에서", "user@example.com으로". WebKit
  breaks inside it after "." and "/" ("코드를 microsoft. / com/devicelogin에", a connection sheet at 320–430); Chrome
  does not. A domain wider than the line wraps inside its box.
- **Flowing text** that does not go through `tied()` (a chat reply's markdown text runs, a stream; a link run is not
  glued, it keeps `overflow-wrap: anywhere`) goes through `glued(text)`: each spot where a browser breaks inside a word
  under keep-all becomes a no-wrap inline (`.t-glue`), not a box, so the rest of the line wraps as before. No character
  is added (no nbsp, no U+2060: the nodes' text is the input, a unit test checks it). The spots:
  - an opening bracket or quote ( （ 「 『 【 〔 “ ‘ and what follows it, a whole number or else one character ("(2.5",
    "(내", "「今"). WebKit's keep-all breaks after an opening bracket before Hangul or kana as an ordinary break, not an
    emergency one: `overflow-wrap: normal`, `line-break: strict` and U+2060 change nothing, and `word-break: normal`
    breaks Korean words. A span around "(" alone moved WebKit's breaks into the numbers (1896 → 2141 cuts, "8, /
    000엔(내원)"), so the spots go together. After a character (not a space, not another opener) it gets a break box
    before it and joins no run before it: keep-all leaves no break between a word and "(", so the glued "(달" made
    "하이엔소아청소년과의원(달빛어린이병원)" one unit, cut inside where it overflowed ("과의원(달빛어린 / 이병원)",
    "06-4708-3666(우 / 메다)"); with the box it reads "과의원 / (달빛어린이병원)";
  - a number with a separator inside (. , : / – -: "10,200", "10:30", "2026-11-17", "03-5579-5993") or with % ‰ ° ℃
    and the letter after it ("93%가"): WebKit breaks at . , : / –, Chrome after a hyphen ("0507- / 1423-0567");
  - a dash inside a word and the number after it ("24일–28일", "10시-12시", "KF-94"): Chrome breaks after the dash; a
    dash at a word's start is a sign ("-5도");
  - a closing bracket or quote with what it closes on (the character before it, the whole number when that is a
    digit) and the mark or letter right after it ("원)", "화),", "は」。", "트)을", "(0120-151-929)이"): a line would open
    with ")" ("(달빛어린이병원 / ) · 위례북로") or the mark, or the word's end would go down alone. Kana and kanji after
    it stay out: Japanese breaks there ("「雨」 / が"). One at the text's start (the text run after a link) stays plain:
    a span opening on ")" put a break between the link and ")" ("carry-in/ / ).");
  - "。" or "、" with the character before it ("す。", "ど、"; "お伝えします / 。" in WebKit);
  - " ·" after a word, the space and "·" in one span ("닉 ·" holds " ·"): no line opens on "·". No line breaks before
    a space (UAX #14 LB7), so the word goes with it; a span from the word's last character ("닉 ·" whole) gave the same
    lines but split words too wide for their line (+26 WebKit, +45 Chrome over a 100–200 px sweep), while " ·" alone
    breaks those at the span's start, as plain text does. The word (from the last break box in it) and " ·" must fit
    a glued run, 16 characters and 9 em: WebKit starts a longer word (a URL) on a line of its own when " ·" is glued to
    it (+328 lines, breaks inside words 60 → 427 over the replies), and a word that fills its line alone takes the
    break at the span's start, the span's space drawn at the next line's start (8 emoji before " ·" at 208 px, text
    size 130 %, 5 px in WebKit). Latin words count 1.25 em a letter, so handles such as "fontanaclinic" ride no "·";
  - "·" inside a word ("전화·카카오톡", "6병·3개월") with the character before it (its whole grapheme cluster, "👍🏻·"; the whole
    number for a digit) or the glued run ending there, and a break box after it when a character follows that may open a
    line (not a closer, a mark or another "·"): Chrome breaks before such a "·" ("전화 / ·카카오톡"; before a digit at almost
    every width, "6병 / ·3개월"), WebKit never. A span alone took WebKit's break after the "·" too (WebKit drops a break at
    a no-wrap span's end: "전화·카카 / 오톡"); with the box WebKit draws the lines it drew before. Plain at the text's start
    (a run after a bold name or link): a span opening a run there breaks off at the element's end, worse than plain (4
    lines × 241 widths in a paragraph, Chrome: 82 lines opening on that "·" plain, 306 with "[·카]", 101 with a box after
    it). Plain too after a closing mark left plain.
  No span or box edge falls inside a grapheme cluster (UAX #29: an emoji with its skin tone, joiners, style selector
  or keycap frame, a flag, a letter with its marks, conjoining jamo, a Prepend sign with what follows, a conjunct
  over a virama; on the safe side never between two regional indicators or after a joiner or virama; the sets
  checked against Intl.Segmenter: every code point after 12 kinds of character, 13.3 million places, and before 2).
  The span takes the whole cluster at either end ("[(🇰🇷] 한국", "가족[👨‍👩‍👧)]", "[👍🏻·]|최고"), within a glued
  run's length, or the spot stays plain ("(" before a family of four, 9.15 em by `glueEm`; five flags in a row).
  WebKit draws a cluster cut by an edge as its pieces: "🇰🇷" as two letter boxes ("🇰🇷·🇯🇵 여행" 84 → 107 px), "👍🏻"
  as a thumb and a square, "👨‍👩‍👧" as three people ("가족👨‍👩‍👧·사진" 86 → 132 px); Chrome draws it whole. Edges
  inside a cluster over 968 shapes of emoji sequences and marks beside every kind of spot (Intl.Segmenter): glue-4
  312, snap-fnd-midot 328, snap-fnd-midot-2 0; the saved replies and run-boundary lines have none either way.
  Nothing is glued after a character WebKit sizes apart from how it draws it, up to the line's end ("\n"): WebKit
  lays the text box holding it out at a width other than the one it draws it at, by up to a character's width either
  way, and moves what follows the box on its line by the difference ("(#️⃣ 번호)" with "[(#️⃣]": "번" 10 px to the
  right at 17 px; with "‼️" 13 px to the left, over it). The error sits at the box's end, not beside the character, so
  any span, box, `<b>` or sentence block after it on the line moves; plain text has it at the line's end, where nothing
  follows (a "\n" or a wrap ends it). Chrome draws them right. They are a keycap frame, a style selector or a skin
  tone on # * ‼ ⁉ 〽 ("#️⃣", "*️⃣", "‼️", "⁉️", "〽️"; not the digits' keycaps, "1️⃣"), a style selector or keycap frame
  on no emoji, a skin tone on no emoji that takes one, a mark, joiner or tag with no letter, digit or emoji under it,
  a mark of a script with no font here (Tulu-Tigalari, Glagolitic, Kawi, …), the Hangul fillers and Apple's
  private-use tags. Found by measuring the box's end against plain text in WebKit at 17 and 22 px: 7,190 emoji
  sequences (each emoji alone, with FE0F, FE0E, 20E3 and FE0F 20E3), 8,643 skin tone pairs, 39,195 selectors and
  keycap frames on the other characters up to U+33FF, 203,926 single characters (planes 0 and 1, every 7th of 2 and 3,
  after a space and after Hangul) and 9,460 marks on letters of their own script: 4,517 moved more than 1.6 px, all
  held by the rule (Chrome moved none). On 2,856 lines with these and with control clusters (digit keycaps, toned
  emoji, flags, families, marks on letters, Devanagari, Thai) beside every kind of spot and more spots after them on
  the line, and sentence texts: characters moved over 1.6 px in WebKit at 13, 17 and 22 px, HEAD 1,350–1,364 of the
  1,700 lines (up to 22 px) and 26 of 34 sentence texts (up to 153 px: the sentence block after it), this 0; the
  controls and Chrome 0 either way. In saved text: none of the 21,462 strings of the reply rows, one of 7,751 result
  strings (a private-use character with FE0E). A class scan finds the candidates, the rule runs at each: glued() over
  the saved reply rows (7.24 M units) 161 → 189 ms; a megabyte of hostile text at most 117 ms (HEAD 220 ms).
  A URL-like piece in plain text (between spaces, cut before openers, with "://", "www.", "@x" or "x.yy" in it: a
  domain, a path, a mail address or handle; links are runs of their own) too long for a glued run is not glued at all:
  WebKit drops the breaks inside such a piece when a box edge (a span, `<b>`, `<wbr>`) touches it and cuts it where it
  overflows ("(parking.seoul.go.k / r)에서" with "[(p]" and "[r)에]" glued, "manjar / o/)" with "[(o]" or "[(]" alone;
  plain: "seoul.go. / kr"). WebKit then still ends a line on the "(" before it, as at HEAD (25 lines over the
  replies; a lone "[(]" span ends those but cuts two URLs at 320).
  `glued(text, before)`: `before` is the text of the run drawn right before in the same block (a reply's bold name or
  link; runs are elements of their own, so a spot at a run's start cannot join the run before). An opener at the
  text's start after a character gets a break box (without it WebKit cut "**하이엔소아청소년과의원**(달빛어린 / 이병원)"),
  a " ·" at the start rides on the word `before` ends on (that word, from its last break box, and " ·" fit a glued
  run: "**구름 클리닉** · 8,000엔"), and a word the text starts inside counts with its part in `before` ("**3,000엔**부터
  ·"). The block keeps spaces (`white-space: pre-wrap`, as `.md p`): under `normal`, Chrome breaks before a span that
  opens a run with a space right after an element's end and draws that space at the next line's start (+4.3 px; 138
  lines over the 2001 below with list bodies as at HEAD; WebKit 0). `.md-li-body` with pre-wrap draws HEAD's lines
  unchanged (28,616 blocks of saved lines at 320–430, both engines: the same lines and findings in each).
  Spots side by side make one span, at most 16 characters and 9 em by `glueEm`, an upper bound of the system font's
  widths (digits 0.62, Hangul 1, ( ) “ ” 0.4, anything else 1.25: W 0.93 and emoji 1.18 measured, which the rough
  `em` counts 0.6). 9 em is 199 px at text size 130 %; the narrowest column at 320 is 208 px (the owner's bubble; a
  reply's list item two levels deep 212). Past the cap a dash or a number starts a new span after a break box (the
  break goes before the number: "110-000-123456 / (이하늘)으로"), a closer, "。", "、", " ·" and a word's "·" stay
  plain (a span opening on ")" after a character is where an overflowing line breaks: "W / )W"; a closer right after
  a closing mark left plain stays plain too, "가」」…」" past the cap), and a longer number keeps its breaks. A run
  ending on a closer, "。" or "、" before kana, kanji or an opener ends there, with a break box after it: WebKit drops
  a break at the end of a no-wrap span there ("予約は…ていま[す。]初 / 診は", where plain text breaks after "。"), and the
  box puts it back.
  The break box (`.t-brk`) is an empty inline-block: CSS Text 3 § 5.1 puts a soft wrap opportunity before and after
  an atomic inline whatever keep-all says, in both engines. Not `<wbr>`: with a `<wbr>` earlier in the paragraph,
  WebKit draws the space before a glued span at a line's start (+4 px at 4 of 76 widths in DD's case; 0 with the box,
  breaks the same). A call puts out 2000 spans and boxes at most (a 30,000-character reply holds about 900).
  `.t-glue` is `white-space: pre`, not `nowrap`: WebKit lays a nowrap span with a collapsible space before "·" out past
  the line end (72 of 402 widths in a list item, up to 4.3 px; none with the space kept).
  Measured on the 1576 saved reply lines that hold an opener (199 replies, drawn as the chat draws them: markdown runs,
  links as links; 320–430 px; HEAD → this):
  - WebKit: lines ending on an opener 1127 → 25 (each before a long domain), numbers cut 1917 → 0, lines opening with
    a mark 29 → 3 (after a link: "19382/ / )", and one at a link's edge), a closer's word cut 81 → 1 (a mail address
    left plain, "clinic.com) / 에서", as at HEAD), lines opening on "·" after a space 568 → 78. Breaks inside a plain
    word that HEAD has not: 0 (glue-3: 12). Lines +0.90 % (of 6304 blocks: 257 one line more, 5 two to six more, 18
    one fewer; the +6 is an 8644-character list with 540 " · ").
  - Chrome: numbers cut 670 → 5 (a 25-character number, an ID in a domain), a closer's word cut 67 → 1, "·" 548 → 80;
    breaks inside a plain word: 0 new. Lines +0.70 % (219 one more, 5 two to five more, 32 one fewer).
  - The "·" left (after a space): after URLs and domains (WebKit 44, Chrome 51), mail addresses or handles (8, 6),
    words over 16 characters (7, 5) and words over 9 em (19, 18). Breaks inside links (overflow-wrap: anywhere) stay
    as at HEAD.
  - A "·" inside a word (snap-fnd-midot; HEAD → glue-4 → this): Chrome lines opening on it 130 → 135 → 0 ("카톡 /
    ·LINE"), WebKit 0 → 0 → 0. Against glue-4 every other count stays (the "·" after a space 80 and 78, numbers cut 5
    and 0, …), breaks inside a plain word that glue-4 or HEAD has not 0, lines 28,897 → 28,896 (Chrome) and 28,956 →
    28,954 (WebKit); lines ending on a word's "·" 644 → 752 and 733 → 749. The same with list bodies as at HEAD. On the
    2001 run-boundary lines: Chrome 74 → 80 → 0, lines 31,781 → 31,780 and 31,837 → 31,836, breaks inside a plain
    word 0 new, breaks inside links 1516 → 1518 (Chrome).
  - On 2001 saved lines whose runs meet at " ·" or an opener (bold names, links: "**구름 클리닉** · …", drawn with
    `before`, list bodies pre-wrap): lines opening on "·" after a space 979 → 124 in WebKit and 974 → 124 in Chrome,
    numbers cut 2617 → 0 and 1004 → 6, WebKit lines ending on an opener 624 → 20, breaks inside a plain word that
    HEAD has not 0 (without `before`: 2 in WebKit), lines +1.15 % and +1.12 %.
  - No line is drawn indented (a line's first glyph more than 2 px in; a line opening on a code chip starts at its
    padding and is counted apart), in the replies, the run-boundary lines, the hostile lines and the fixture, both
    engines.
  - Nothing cut off sideways. At 320 with text size 130 %, 70 hostile lines (long account and order numbers, "(1) (2)
    (3) …", "10,000 20,000 …", URLs in brackets, chains of W and emoji before closers, " ·" after words of every width,
    runs of "。" and "」あ", "가(나)다(라)…", "a(b" × 40, long domains in brackets, closers at the start; and since
    snap-fnd-midot 12 of "·" inside words: chains of Hangul, W, emoji, "❤️" and "👍🏻", digits, "(1)·(2)" and
    "1,000·2,000", words at and past the cap, URLs, closers and marks, Japanese) and 9 lines
    of bold and plain runs by turns, drawn with `before` (emoji, W and Hangul names of every width before " ·", "(1)"
    "(2)" … across runs, URLs and mail addresses before " ·"), run past no column (the paragraph 280 px, list items
    230 and 212, the owner's bubble 208; lines.mjs's 0.5 px), in both engines.
  - Time (Bun, the Mac under load): about 0.51 ms for 8,000 characters (518 spans and boxes; 0.43 ms and 424 before
    a word's "·" was a spot); glued again at every 4 streamed characters, an 8,000-character reply costs about 500 ms
    in all (0.25 ms a call); a megabyte of hostile text 0.4–55 ms (of "·" inside words 0.9–38 ms), linear (2000 spans
    and boxes at most; URL-like pieces are found once a call; `before` is read back 16 characters at most).
  A long synthetic reply and its expected findings (qa/fixtures/glue-reply.mjs › GLUE_REPLY, GLUE_RULES, GLUE_EXPECT:
  none once its runs go through `glued()`) are there for lines.spec's chat area.
- **One-syllable words** ride over a nbsp, in one box, on the word they belong to, so none ends or starts a line alone
  (16 characters at most). Forward: a determiner standing alone (이 그 저 새 헌 각 몇 온 총 약 한 두 세 네 첫) and the next
  word ("한&nbsp;번", "새&nbsp;메시지", "총&nbsp;23&nbsp;곳"; "네," with its comma is an answer and stays); a period noun (월
  연 년 주 일 회) and an amount after it (최대 최소 최고 평균 단위, 약 or 총 standing alone, or a number: "월&nbsp;최대",
  "연&nbsp;4.5%", "주&nbsp;3회"; "주 정부" and "일 처리" stay apart); an area noun (시 군 구 동 읍 면) and "단위"
  ("구&nbsp;단위까지만"). Back: an auxiliary verb (둔 둘 둬 뒀 준 줄 줘 줬 본 볼 봐 봤) on the -아/-어 form before it, read
  by its last vowel (ㅏ ㅓ ㅕ ㅐ ㅘ ㅝ ㅙ, no final consonant: "예약해&nbsp;둔", "적어&nbsp;줘", "써&nbsp;볼"; "할 줄" stays
  apart).
- **Where it is on:** ListRow `title` and `subtitle`, List / ListSection `footer`, LargeTitle `subtitle`, EmptyState `body`,
  TextField `hint` and `error`, the banner body (line-clamped, see below), Spotlight `emptyHint`. A screen's own
  copy slot uses the same three things (`copy()`, `<Sentences>`, `.t-copy`) instead of its own pretty and spans. In a
  flex container, wrap the copy in a span first: each sentence span would otherwise be a flex item of its own.
- **No tie wider than its line.** A tie wider than its line wraps inside its box: the box takes the line whole, so
  what follows goes down a line, and a nbsp at its break is drawn at the next line's start ("고성군문화복지센터&nbsp; /
  · 강원" in a results row at 320, the dot 3–4 px in, three lines for two). A slot that can be narrower than its ties
  gives its narrowest line in em at the width at hand, `copy(text, { line })`, the width read by `useWidth(ref)`
  (before the first paint and on every resize): no tie or nbsp run is wider by `emWidth` (below), past it a "·" stays
  apart and the word keeps its own tie when that fits, and the sentence blocks stay. Not the narrowest phone's line at
  every width: a tie that fits a wider line then comes apart there too ("보내줘” / 라고 입력했다." at 430, "·" opening
  lines). A line-clamped slot gives it as `clamp` (below). lines.mjs reports a tie laid on two lines (`wide-tie`).
  Measured on results subtitles (320 from saved replies, 876 made up; each with and without a link) at 320–430 × text
  size 0.9–1.3 in Chrome and WebKit, 95,680 rows: rows with a tie wrapped inside its box 16,153 → 0, indented lines
  1,136 → 0, lines 171,739 → 158,789, no row a line longer. Of the 97,287 ties held on one line before, 516 broke
  inside with ASCII on `emWidth`'s steps, 173 with its per-character widths (snap-fnd-em-latin; 134 of them a word
  and its "·"; the rest within the margins of `emWidth`, each character's widest over every size and Hangul's 1, and of
  'when'). With 320's line at every width the same rows broke 1,754 (1,707 at 360–430). Lines opening on "·" 2,425 →
  2,774: a word that fills its line leaves its dot to the next one; 2,677 with the per-character widths, lines
  158,789 → 158,803: 14 rows a line longer, each for a tie that fits now, a word kept whole that broke inside
  ("엠스테이지 (구. / 인사아트홀) · 서울" → "엠스테이지 / (구.인사아트홀) · / 서울", 10) or a word and its "·" whose dot
  opened the last line ("지 라이브홀 / · 서울" → "지 / 라이브홀 · / 서울", 4).
- **Line-clamped slots** take `copy(text, { clamp })`, `clamp` the slot's narrowest line in em: no sentence blocks (a
  sentence box would be one tall line to the clamp) and no tie or nbsp run wider than that line by `emWidth(text)`, an
  upper bound of the system font's width: the app's `--font-text` at every size the app draws text at (the type tokens
  13–34 px × text size 0.9–1.3: 11.7–44.2 px), letter spacing 0, the widest over those sizes in Chrome and WebKit on
  macOS, for every assigned code point of the BMP and plane 1 and every 7th of planes 2–3 (92,283 code points and emoji
  sequences; marks and format characters draw on the character before them and count 0). qa/fixtures/em-widths.mjs
  keeps 474 of them (the saved replies' characters, ASCII, Latin-1, punctuation, symbols, emoji sequences, each group's
  widest and its edges), and text.test.ts checks `emWidth` is never under them:
  - Hangul, kana, Han, CJK punctuation, jamo ("ㅋ"), enclosed and compatibility forms ("㈜", "㎏") and full-width forms 1
    (0.99; Hangul is 0.87 here and near 1 in other fonts, so it stays wide); old jamo, compatibility ideographs and five
    brackets and marks 1.03 (1.02: "ㆼ", "〚");
  - ASCII and Latin-1 each at its own width, rounded up to 0.001 (a table: a space and a nbsp 0.284, "·" 0.3, "i" 0.25,
    "1" 0.467, "a" 0.555, "m" 0.873, "W" 0.97), and a pair of them whose kerning widens it adds that on its first
    character (348 pairs of 46,656 with the marks below: "_j" 0.079, "r’" 0.064, "Tì" 0.059);
    qa/fixtures/em-widths.mjs `EM_STRINGS` keeps every such pair and 173 strings (Latin words, domains, numbers, runs),
    each the widest drawn over the same sizes and engines, and text.test.ts checks `emWidth` is never under them;
  - the marks Korean copy uses past Latin-1 on steps: ‘ ’ 0.32, “ ” • 0.48, † ‡ 0.56, – 0.63, … — 0.88, ← ↑ → ↓ ₩ 0.97;
  - emoji, the other Latin, Greek and Cyrillic letters and "‰" "‱" 1.5 (1.47; a skin tone after an emoji and an emoji
    joined to the one before add nothing, a keycap's frame 1); the other symbols 1.2 ("℃" 1.19, "★" 1.03); other
    scripts and the five widest symbols 4.7 ("﷽" 3.21, cuneiform up to 4.64).

  The sizes matter: SF is wider at text sizes than at display sizes ("a" 0.555 em at 11.7 px, 0.502 at 100; "…" 0.81
  and 0.59), and WebKit draws emoji on whole pixels (1.47 em at 13.65 px, 1.08 at 100). A first cut measured at 100 px
  still let "“😂😂😂😂😂”처럼" (9.96 em drawn, 8.4 by that cut) wrap inside its box in the owner's bubble of the room card
  (WebKit, 320, text size 100 %). Measured with the fonts macOS (and iOS) draws; other platforms' fonts are not
  measured, and Hangul's 1 keeps a margin there. Until snap-fnd-em-latin ASCII sat on nine steps (0.32 to 0.97) and
  Latin-1 on two: a Latin string counted ×1.067 its drawn width (the median of 5,729 ASCII and Latin-1 strings, ×1.190
  at p90), ×1.008 by the table (×1.022), none under in 10,656 strings (words, domains, mails, numbers, runs, curly
  quotes) at the app's 69 sizes in both engines; the steps' margins hid most kerning but not all: 13 pairs drew wider
  than they counted ("r’" 0.71, drawn 0.745; ",/" 0.64, drawn 0.645).
  Until snap-fnd-em it was a rough measure (Hangul, kana and CJK 1, the
  narrow marks 0.3, anything else 0.6) that counted jamo outside the syllables, emoji, most capitals and some digits
  under their width. Through 17 clamps (the banner's 10 and 5, the room card's 15), by the widths drawn at the app's
  sizes, it let 76 boxes over their line in the saved replies (1576 lines, 238,574 boxes), 1044 in 268 chat-style lines
  ("(ㅋㅋㅋㅋㅋㅋ)" counted 4.8 em, 5.96 drawn; "😂😂😂😂😂·" 3.3 and 7.62; "WWWWWW·" 3.9 and 6.09) and 82 in 388 lines of
  capitals, numbers and emoji; 0 by `emWidth`, and 0 in the room fixture either way. On the replies it ties 13,545
  character boundaries more and 7,223 fewer: boxes that fit the font but not the bound's margins (the steps, Hangul's
  1, the smallest size), "06-6786-8880," 7.50 em drawn and 7.94 by `emWidth`, "OSAKA(오사카" 6.40 and 7.07 against the
  room's 6.7 (7.57 and 6.81 by the per-character widths).
  On the room card (its two highlights, one the owner's, a 4-line clamp; four long ties at 320 and 390,
  text size 100, 120 and 130 %, both engines: 96 highlights) the rough measure showed 5 or 6 lines in 15, each a tie
  wider than its line wrapping inside at 320 ("“😂😂😂😂😂”처럼" 121.6–152.3 px, "(ㅋㅋㅋㅋㅋㅋㅋㅋ)", "ㅋㅋㅋㅋㅋㅋㅋㅋ·");
  `emWidth` 0. The banner (16 bodies at 320 and 390, 100 and 130 %): ties wrapped inside 2 → 0, bodies cut by the
  height stop 4 and 4.
  That holds for the "·" rider too: past the clamp the dot stays apart and may open a line, and the word keeps its own
  tie. At 5.4 em (the room card's rows at text size 130 %) "32,400원&nbsp;·" is 5.03 em and rides; "132,400원&nbsp;·"
  is 5.50 em, so "132,400원" (4.92) is tied alone and the dot may open the next line (WebKit's pretty takes that break
  even where the pair fits). Before, the run was left untied and WebKit split "132, / 400원": a split amount
  reads worse than a dot at a line's start. Beside 실행 취소 (5 em) "132,400원" is tied too (4.73
  em drawn at 11.7 px; with ASCII on steps, 5.07, it was left untied).
  Pretty stays on in these slots: greedy lines (`text-wrap-style: auto`)
  took 4 of the 6 dot starts in the banner probe away, but gave 40 of the 168 bodies shown whole on two lines a
  one-word second line (pretty: 0 of 164) and split one more number. -webkit-line-clamp counts a box that wraps inside
  as one line, so a 2-line clamp showed three, up to five with a long 「…」 quote, at 320 with text size 130 %. The
  banner body: 10 (212 px there), 5 beside 실행 취소 (100 px). Its `max-height: 2.7em` stops a box a font wider than the
  measured one would wrap; it cuts without the ellipsis, so the clamp value is the fix and the height only the stop.
- **Chat bubbles keep pretty off on purpose.** WebKit rebalances most multi-line bubbles with it: 24–32 of 30–44
  re-broke at 320–430, orphan or not. The shrink-to-fit box keeps its full width, so an empty band up to 82 px opens on
  its right. Chrome re-breaks only the orphans. The chat narrows a bubble with an orphan instead
  (`screens/chat/bubbleFit.ts`).
- **Narrow cells.** In a column under 160 px most lines are short, and pretty and sentence blocks only add lines (WebKit
  at 106 px: 4 lines → 6). A cell that can get that narrow takes `.t-cell` (a size container; ListRow's text column has
  it): under 160 px its copy wraps plainly, ties kept. Put `.t-cell` only on a box whose width does not come from its
  content (a growing flex item, a block): an inline-block or a shrink-to-fit flex item collapses to nothing under
  inline-size containment. So a List or ListRow never sits in a parent sized by its content (a popover, an inline-flex
  menu): its text column would collapse there. A narrow cell is a layout question for its screen (a detail or chips
  under the line at 320).
- **The check** is `qa/lib/lines.mjs`: it rebuilds each block's lines per character (word Ranges misread lines where
  Korean breaks inside words) and reports a line ending on an opening bracket, a line starting with a closing bracket,
  "·", ".", ",", "!", "?", ":" or ";", a line ending on a closing bracket or quote while its word goes on ("줘” /
  처럼"), a number at a line's end with its unit opening the next ("3만 / 원은"; the same unit list as Text.tsx, and a
  unit test keeps the two in step), a word holding a number cut inside while it fits the block ("3. / 3만"), a word holding a domain cut inside
  while it fits (`url`: "microsoft. / com"), a
  one-syllable word cut from its word: forward `det` ("한 / 번") and `per` ("월 / 최대", "구 / 단위"), back `aux` ("예약해 /
  둔"; the same lists as Text.tsx), a last line of two characters or fewer (grapheme clusters: 👍🏻 is one; a last line of nothing but emoji is not
  one), two emoji side by side split over two lines (Chrome breaks "🍜 / 🍜"), a sentence that fits on one line but
  runs over two, a line's last glyph more than 0.5 px past its block, a character laid out on two lines at once (drawn
  twice), and copy rules that add lines (the block laid out again with plain wrap: from 160 px one more line for two
  sentences or more, none for one; under 160 none). The plain layout turns off only the wrap style
  (`text-wrap-style: auto`): the `text-wrap` shorthand would also unwrap ties. Copy blocks under 160 px are listed
  apart, as narrow cells for their screens. Flowing prose (a chat reply) carries `data-lines="prose"`: every rule but
  the sentence one. `qa/lines.spec.mjs` sweeps the app with it (320 / 360 / 390 / 430, Chrome and WebKit) and fails on
  findings in foundation blocks; other screens' findings are listed for their owners. The chat's cards come from a
  fixture thread (`qa/fixtures/lines-cards.mjs`, every card kind). It includes a '전부' answer on three html cards that
  explore.ts draws at run time; their heads are measured inside the frames.
- **Repro pages:** a double-quoted font name inside `style="…"` ends the attribute, and font, keep-all and text-wrap
  drop without a word. Use single quotes, and look at one screenshot before trusting numbers.
- **Specs reading copy:** tied words sit over a nbsp (U+00A0: "이&nbsp;기기에서", "깨워&nbsp;줘”처럼"), and a regex or
  `===` with a plain space misses them. Fold it first: `text.replace(/\u00a0/g, " ")` (chat, more and skill-accounts
  specs do). `\s` in a regex already matches it.

## Data (`src/api/store.ts`)

The hooks are `useSyncExternalStore` selectors:

```ts
useSession() · useUi() · useAgent() · useQuota() · useThreads() · useThread(id) · useMessages(id) · useDraft(id)
useConnections() · useProfile() · useSettings()
loadThreads() · loadMessages(id, { older }) · loadConnections() · loadProfile() · spendTicket(kind)
updateSettings(patch)    // optimistic; display prefs are applied at once and rolled back on failure
logout()
```

**Streaming a chat turn** (contract: `docs/architecture/SERVER-CONTRACT.md`):

```tsx
const { items, draft, streaming, error, failed } = useMessages(threadId);
const r = await sendMessage(threadId, text, { attachmentIds });   // POST → fetch-streamed SSE; the draft fills token by token
if (r.keepText) restoreComposer(text);                            // 409 busy (other thread) / 400 / 413: bubble removed, banner shown, keep the text
if (!r.ok) showInlineError(r.error.message);                      // Korean, from the server's { error, message }
// r.status: "done" | "steered" (202: bubble shown, the running turn continues — r.steered) | "delivered" (201 friend
//           thread, no agent turn) | "busy" | "rejected" | "failed" (bubble kept in `failed` + `thread.error`: 429 quota,
//           5xx, stream error / cut, network) | "aborted" (error.code "aborted")
// while it runs: draft.text, draft.tools (ToolActivity), draft.cards
useTurnRunning(threadId) · isTurnRunning(threadId) · stopTurn(threadId)   // composer send ↔ Stop (cancelTurn = alias)
decideApproval(threadId, card.approvalId, "approve")   // signs `approve:<id>:<nonce>` with the device key; streams the resumed turn
retryMessage(threadId, failedId);
markThreadRead(threadId);       // local unread:false (the server clears it on GET messages without a thread_updated)
// errors: ApiError { status, code, message (Korean), data? } — data = the parsed error body, e.g. 400 bad_code → { attemptsLeft }
```

- The agent state / island is updated for you (thinking → tool → streaming → done | awaiting_approval | error).
- Connections: `connectProvider(provider, req)`, `submitConnectionCode(provider, code)` (enter_code),
  `pollConnection(provider, onUpdate?, { signal })` (display_code: polls `verify {}` every 2 s and listens to the
  `connection` event until connected / error). Explore: `startTemplate(id)` → `{ kind: "connections" }` (connect-kakao)
  or `{ kind: "thread", thread, prompt, autoSend }` (call-demo: `autoSend: false`).
- Server events (`api/events.ts`, `GET /api/events?token=`) arrive as banners. `setOpenThreadHandler` routes
  notification / island taps to `nav.push("thread", { threadId })`, so register a `"thread"` screen.
- Lock-screen notifications (Web Push, B1c) live in `app/push.ts` and `public/sw.js`.
  - The worker shows each push's title only (the body is always empty), with its sound, also while the app is on screen
    and shows its own banner (DD 2257: never hide a stop line to avoid a double; WebKit revokes a subscription that
    breaks userVisibleOnly). The next line of the same tag replaces the old one and alerts again (`renotify`). It has
    **no fetch handler**: it never caches or serves the app. `qa/push.test.ts` fails if a fetch listener appears.
  - Nothing is registered or requested until notification permission is `granted`. After that the shell calls
    `syncPush()` on every start with a session (after `afterStartup()`), when the permission turns granted, and when
    the worker reports a replaced subscription. A screen that asks for the permission can `await syncPush()` for the
    state: `subscribed` · `off` (503 push_off) · `invalid` (400, "이 기기로는 알림을 보낼 수 없어요") · `no_permission`
    · `unsupported` · `error`.
  - Whether to offer the permission at all is `await pushAskable()` (DD 2330, DD 2334), the one rule for the
    notification settings card and the invest screen's paper: Web Push exists here (on iOS only in an app added to the
    home screen), the permission is still `default`, and the server gives its key (503 push_off while it sends nothing,
    404, unreachable → no offer). Ask only after a press, call `Notification.requestPermission()` inside that press,
    then `await syncPush()`.
  - A tap opens its target. With a thread, that thread on the chat tab. An invest notification without a thread
    (`invest:blind`) opens `"invest"` on 나의 모시 when that screen is registered. A running app gets a worker message;
    a cold start gets `/?open=thread&thread=…&message=…` or `/?open=invest`, read once and removed from the address.
- For credentials, `sealCredential` / `saveCredentialSealed` in `endpoints.ts` seal the secret for the enclave
  (`@pickle/vault/client`, aad `${userId}:${service}:${kind}`) before it leaves the device. `attachmentUrl(id)` /
  `blobUrl(id)` add `?token=` for `<img src>`.

## Wallpaper (`src/three`)

`WallpaperHost` (first-load chunk) paints the wallpaper with the first frame — CSS only, static, nothing at rest
(MOTION-SPEC §0 "Wallpaper"):

- `--bg` plus one soft light from above (`Wallpaper.css`): a wide ellipse on the top edge, raised-cosine falloff,
  gone by half the height. Its colour is the agent's hue (`useAgent().avatar.hue`, the profile colour dots) mixed
  10 % (dark 12 %) into a neutral in oklab; no agent colour → the neutral (`--wp-light-neutral`, `--wp-light-mix`).
- A static grain over the light's region dithers 8-bit banding (± ~1 level); the flat base stays flat.
- No WebGL, drift, parallax or rAF. The light re-tints once on `camera` when the agent's colour changes (instant under
  reduced motion, never during the theme swap). Reduced transparency / increased contrast / forced colours: the
  plain base.
- `palette.ts` is the CSS's JS twin: `wallpaperColorAt()` and the legibility `veilFor()` (0 everywhere on this
  wallpaper). `qa/wallpaper.test.ts` keeps CSS, tokens and model in step; `qa/wallpaper.spec.mjs` shoots and measures.
- `<Glass lens>` is accepted and ignored (the WebGL SDF lenses went with the WebGL wallpaper). `data-wallpaper="css"`
  stays on the host for QA.

## Performance

Budget (390×844, Chrome, CPU 4×, Fast 4G, production build via `vite preview`): first-load JS ≤ 180 KB gzip, LCP
≤ 2.5 s, TBT ≤ 200 ms.

- **First load** is two parallel, modulepreloaded files plus a 0.4 KB runtime: `vendor` (react, framer-motion; stable
  across app deploys) and the entry (shell and chat route). The split is set by `codeSplitting.groups` in
  `vite.config.ts`, keyed on rolldown's `$initial` tag. Everything not statically reachable from the entry stays in
  automatic lazy chunks: `lazyScreen()` screens, the gallery, three/R3F (≈ 242 KB gzip), liquid-glass and the
  adaptive pointer.
- **Startup order** (`app/startup.ts`):
  1. `afterStartup()`: window load → no JSON request in flight for 400 ms (the first screen's reads are in) → an
     idle period. Capped at 8 s.
  2. `prefetchLazyScreens()`: every `lazyScreen()` chunk in parallel (skipped under Save-Data).
  3. `afterStartupEffects()`: three/R3F, AgentBlob, liquid-glass.

  Use `afterStartup()` for your own optional background work.
- three is never on the critical path. It is skipped under reduced motion, Save-Data, reduced transparency, low
  memory / power and software GL.
- Measured on 2026-11-12, as medians of 5 cold loads:

  | Metric | Value |
  |---|---|
  | First-load JS | 200 KB gzip: `vendor` 122 (react-dom ≈ 62, framer-motion ≈ 50) + app 78 + runtime 0.4 |
  | Onboarding (logged out) | LCP 0.80 s |
  | Chat (logged in) | LCP 1.23 s |
  | TBT | ≤ 39 ms |
  | three chunk | requested at ≈ 2.7–3.2 s, done ≈ 3.2–3.7 s |
  | three under reduced motion / Save-Data | never requested |

  To get under 180 KB, the next steps are framer-motion `LazyMotion` with async features (drag is unused, but
  projection is needed for `layoutId`) and per-type lazy chat cards.
- Re-measure after adding a dependency or a static import of something heavy. `vite build` prints each chunk's
  gzip size. The entry's statically imported files are what counts.

## QA

```sh
bunx tsc --noEmit -p apps/mobile && bun run --filter './apps/mobile' build && bun test ./apps/mobile/qa/*.test.ts
# (not `bun test apps/mobile/qa`: bun also runs *.spec.mjs files, i.e. the Playwright scripts)
node apps/mobile/qa/foundation.spec.mjs        # QA_ENGINES=chromium|webkit  QA_VARIANTS=light,dark,reduced  QA_PERF=0  QA_ONLY=motion
QA_BASE=http://127.0.0.1:<preview> QA_API=http://127.0.0.1:<server> node apps/mobile/qa/lines.spec.mjs   # line breaks, 320–430, both engines
# while screen modules are still missing: stub them in a separate build
bunx vite build -c apps/mobile/qa/vite.qa.config.mjs && QA_DIST=dist-qa node apps/mobile/qa/foundation.spec.mjs
```

- Playwright 1.62.1 runs Chrome (`channel: "chrome"`) and WebKit 2336. Never run `playwright install`.
- Screens are 390×844 @3x. Screenshots and `results.json` go to `docs/qa/foundation/`.
- The run fails on console errors, page errors, horizontal overflow, and the §8 motion checks:
  - idle cost, 2 s after load and after a tab round trip: `document.getAnimations().length === 0` and no rAF
    callbacks except the wallpaper's (rAF registrations are attributed by stack; with `?gl=off` there must be none);
  - tab switch: the old page hidden from the first frame, the new page's opacity > .2 at ~50 ms, blurred area ≤ 25 %
    of the viewport on every frame.
- In gallery mode the other tabs are real tab layers (`GalleryTab`), so the tab transition is the production one.

## Gotchas

- **Rounded clips:** a rounded `overflow: hidden`, `clip-path` or `mask` on an ancestor makes Chromium ignore a bar
  group's clipped backdrop-filter, which then shows as a blurred rectangle. Don't wrap shell chrome in rounded
  clips. The device corners are painted (`.device-corners`) for this reason.
- **liquid-glass-js** appends its lens to `<body>` (position: fixed). The tab bar hides it whenever
  `html[data-overlay]` is set (a sheet or the drawer is open). Use `setOverlay(id, on)` from `app/device.ts` for
  any new modal surface.
- **Portals** for overlays go to `getOverlayEl()`, which sits inside the device, never `document.body`.
- **Glass carrying text needs a backing:** use `text` (higher tint) and `adaptive` (luminance veil) when it sits
  over busy wallpaper.
  The same goes for glass carrying an icon in the chrome (menu circle, trailing circles): low-tint shape glass picks up
  the wallpaper's blue through `saturate(190%)` and reads as an accent tint.
- **StrictMode (dev):** effects run mount → cleanup → mount. A `mounted` ref must be set to `true` in the effect body,
  not only cleared in its cleanup; "first run" flags should compare against the previous value instead.
- **Fast Refresh:** keep component files component-only (non-component exports such as controllers live in plain
  `.ts` modules, e.g. `app/navLayers.ts`).
