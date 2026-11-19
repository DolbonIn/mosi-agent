Method: dual-agent (A: critique-a1 · B: impeccable detector over CDP, run by design-director)

# Critique: 음성 통화 오버레이 (Voice call overlay)

2026-11-12 · Mode: Operate · Screens: `18-call-overlay`, `19-call-minimised-island` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Real phases ("연결 중 / 듣고 있어요 / 생각하는 중 / 말하는 중 / 음소거 중") and a tabular timer in the island. Silence is drawn three ways at once, and two of them look like placeholders (a dashed island meter and a stray 4 px dash under the blob). |
| 2 | Match Between System and Real World | 3 | Phone-call grammar people already know: name, status, three round controls, red end. "듣고 있어요" plus "말씀하시면 깽이가 들어요" says the same thing twice. |
| 3 | User Control and Freedom | 3 | A minimise chevron, Esc, and a single-tap end. Tapping the minimised island reopens the card. You can't end or mute from the minimised island without reopening it first. |
| 4 | Consistency and Standards | 2 | Toggle labels flip between action and noun ("스피커 끄기" / "스피커") while `aria-pressed` also carries the state. The end button uses three different reds (card, dark card, island). Buttons are 68 px against DESIGN's 64 px. |
| 5 | Error Prevention | 3 | Mute is disabled while connecting and speaker is disabled without TTS. End needs no confirm, which matches the platform. |
| 6 | Recognition Rather Than Recall | 3 | Every control has a visible word under it. |
| 7 | Flexibility and Efficiency of Use | 2 | Esc only. The minimised island has no quick actions. Type-to-talk appears only when STT or the mic fails, never as a choice. |
| 8 | Aesthetic and Minimalist Design | 3 | Calm and focused, with one object. Minor noise: the duplicate level dash, the duplicate hint, and the white speaker disc as the brightest thing on screen. |
| 9 | Error Recovery | 3 | `call-error` with `role="alert"`, and a typed fallback ("글자로 말하기") that appears on error, so the call survives a denied mic. |
| 10 | Help and Documentation | 3 | A short contextual note ("말씀하시면 깽이가 들어요"; without STT, "음성 인식을 쓸 수 없어서 글자로 말할 수 있어요") at the moment it is needed. |
| | **Total** | **28/40** | **Good** |

## Design Specificity Verdict
**LLM assessment.** This is the most authored surface in the chat feature. The call card is the Dynamic Island grown to full screen: black because the island is black, with the timer kept in the island at the top instead of duplicated in the card (`CallOverlay.tsx:172`), and the agent's own character as the face of the voice. No other product could ship this screen unchanged.

The generic residue is small and specific. There is a level bar under the blob that any audio app would have. The island's level bars resting as five 2 px dashes look like a loading placeholder. A hint line restates the status. Everything else belongs.

**Deterministic scan.** See Assessment B.

## Overall Impression
Good bones, and the right idea: one object, the island, becomes the call. What weakens it is over-reporting. On a silent line the screen shows "듣고 있어요", "말씀하시면 깽이가 들어요", a dashed meter in the island and a lone dash under the blob, which is four signals for one state. Two control-level details also need fixing: the end button's red changes with the theme on a surface that never does, and the toggles describe themselves in two contradictory ways. The biggest opportunity is to let the blob alone carry the level and let the status line alone carry the phase.

## What's Working
- **One object, start to finish.** The composer's call circle stretches into the island, and the island opens to the full device. Minimising folds back toward the island, and the island keeps the timer (`CallOverlay.tsx:112-159`, `172`). That is MOTION-SPEC §5/§6.10's "the call screen itself is the island grown to full card" built literally, and it matches the brand's "Calm by default, alive when working".
- **Controls an iPhone user trusts at a glance.** There are three 68 px circles with a word under each ("음소거", "스피커 끄기", "통화 종료"), and end is the only red (`CallOverlay.tsx:213-245`, `call.css:178-215`). Each sits in the thumb zone at the bottom 15 % of the screen.
- **It degrades into a working call.** Without STT, or with the mic denied, a "글자로 말하기" field appears, so the person can still talk to 깽이 in voice mode (`CallOverlay.tsx:211`, `262-281`). Each turn is sent into the thread with `mode: "voice"` (`callStore.ts:148`), so the call leaves a record. That is "Done, then shown".

## Priority Issues

**[P2] Silence is reported four times, and two of the four look broken**
- **What:**
  - *Text.* The header says "듣고 있어요" (`CallOverlay.tsx:167-169`), and a transcript note directly above the controls repeats it: "말씀하시면 깽이가 들어요" (`callStore.ts:239`, `258`).
  - *Meters.* There are three level displays: the blob's own `amplitude` (`CallOverlay.tsx:177`), a separate 120×4 px bar under it (`CallOverlay.tsx:178`, `call.css:86-94`), and the island's five bars (`DynamicIsland.tsx:150`, `206-215`). At zero level, the bar collapses to a 10 px grey dash floating 60 px under the blob, and the island bars collapse to 2 px dashes that read as "-----" (`DynamicIsland.css:125-133`, `scaleY(0.12)`).
- **Why it matters:** MOTION-SPEC §8.3: "Level bars only show real values". These do, but a dash at rest reads as a glitch or a loading state, not as "quiet line". In DESIGN, the agent character is the one expressive element, and the extra bar competes with it for the same job.
- **Fix:**
  - Delete `.call-level` and its `<span>`; the blob already takes `amplitude`.
  - In the island, raise the rest floor so silence reads as a meter at rest: `scaleY(max(0.25, …))`, 4 px rounded dots.
  - Push the "말씀하시면…" note only when the phase text cannot say it. Keep it for the no-STT fallback ("음성 인식을 쓸 수 없어서 글자로 말할 수 있어요") and drop it when STT is available (`callStore.ts:239`, `258`).
- **Evidence:** `18` and `19` in all engines and themes. `CallOverlay.tsx:167-178`, `call.css:86-94`, `DynamicIsland.tsx:150`, `206-215`, `DynamicIsland.css:125-133`, `callStore.ts:239`, `258`.

**[P2] The end button's red changes with the theme on a surface that is always black**
- **What:** `.call-btn[data-end]` uses `var(--danger)` (`call.css:209-212`). That is `#d70015` in light (`tokens.css:25`) and `#ff6961` in dark (`tokens.css:137`). The card itself is island black in both themes (`call.css:12`). In dark, the white glyph on `#ff6961` comes to about 2.8:1, under the 3:1 minimum for a control's graphic. The island's own end button hard-codes a third red, `#ff3b30` (`DynamicIsland.css:186-189`).
- **Why it matters:** The same action on the same black surface looks different depending on a setting the surface ignores. In dark it also fails non-text contrast on the one control that must never be missed.
- **Fix:** Add one call-scope token, `--call-end: #d70015` (white glyph about 5.4:1), used by both `.call-btn[data-end]` and `.island-btn.end`, regardless of theme. While there, use `--island-label` instead of the island's other hard-coded colours (`#fff`, `#000`, `rgb(255 255 255 / 0.16)`, `DynamicIsland.css:172-189`).
- **Evidence:** `chromium-dark-18`, `webkit-dark-18` (salmon) vs `chromium-light-18` (red). `call.css:209-212`, `tokens.css:25`, `tokens.css:137`, `DynamicIsland.css:186-189`.

**[P2] Mute and speaker describe themselves twice, in opposite ways**
- **What:** The labels are actions that flip with state: "음소거" → "음소거 해제", and "스피커 끄기" → "스피커", where the off state's label is a noun, not "스피커 켜기". The same buttons also set `aria-pressed` (`CallOverlay.tsx:214-226`, `252`). A screen reader announces "스피커 끄기, 선택됨" (turn speaker off, selected). Visually, the "on" state is a white disc (`call.css:205-208`), the brightest thing on the black card, so in `18` the eye goes to the speaker button before the agent. The island's expanded controls repeat the same pattern (`DynamicIsland.tsx:245-260`).
- **Why it matters:** A toggle should name what it is and show whether it is on. Saying what it will do and also marking it pressed is a double negative for VoiceOver users, and "스피커 끄기" next to "음소거" breaks the label pattern for sighted users too.
- **Fix:** Use constant labels, "음소거" and "스피커", with `aria-pressed` carrying the state. The visible label never changes and the fill shows the state. To lower the on-state's glare, use `--island-label` at 88 % instead of 100 % for `[data-on]`; the icon stays `--island`.
- **Evidence:** `18` (all engines). `CallOverlay.tsx:214-226`, `252`, `call.css:205-208`, `DynamicIsland.tsx:245-260`.

**[P2] The agent's hero render is aliased on the only screen where it is the hero**
- **What:** At 196 px the blob shows stair-stepped edges along its lower-right silhouette and around the eyes in every engine and theme. The canvas renders with `dpr={[1, 1.5]}` and `antialias: false` (`three/AgentBlob.tsx:175-176`, documented at `:15`).
- **Why it matters:** DESIGN makes the character "the one expressive element", and on the call card it is the only visual. Jagged edges on a 2×/3× phone make the signature look low-fidelity right where the person is looking.
- **Fix:** Use a size-gated quality tier. When the blob renders at 160 px or larger (call card, onboarding hero), use `dpr={[1, 2]}` and `antialias: true`. Small avatars keep the current low-power settings. Check the result against MOTION-SPEC §7's budget on a real device; nothing else is drawing while the call card is up.
- **Evidence:** `18` in all four captures. `three/AgentBlob.tsx:15`, `175-176`.

**[P3] Korean particles and the minimised island**
- **What:**
  - *Josa.* The call dialog's label and the island's label hard-code "와": `${name}와 통화` (`CallOverlay.tsx:150`) and `${call.name}와 통화 중` (`DynamicIsland.tsx:91`). That is wrong for an agent name that ends in a consonant. `josa()` exists (`util.ts:96-100`) and is already used with exactly this particle pair in the invite sheet (`ChatScreens.tsx:144`).
  - *Minimised island.* In `19` the island shows avatar, "00:03" and five dashes, with no word saying a call is on, and it sits 4 px above the top-bar capsules (11–48 px vs 52 px).
- **Why it matters:** PRODUCT Principle 5 ("Korean grammar (josa) handled correctly"), and the names here are user-chosen. The island is the only sign of a live call while the person reads the thread, so it should be readable at a glance.
- **Fix:** `${josa(name, "과", "와")} 통화`. Apply the dot floor from the first issue so the island doesn't show dashes. Keep the timer.
- **Evidence:** `19` (all engines). `CallOverlay.tsx:150`, `DynamicIsland.tsx:91`, `util.ts:96-100`.

## Cognitive Load
Checklist failures (1, low):
- **Visual hierarchy:** minor fail. The white "on" speaker disc outshines both the agent and the red end button. Otherwise one focus, three controls, one status.

Passing: single focus, chunking, grouping, one thing at a time, minimal choices (3 controls + minimise), working memory, progressive disclosure.

Decision points with >4 visible options: none.

## Emotional Journey
- **Start:** the circle stretches into the island, which grows into the card. Not judged from stills, but the design intent (one object) is the right emotional frame: the agent "picks up".
- **Connecting:** "연결 중" with a small ring. Honest.
- **Listening in silence (`18`):** a valley. The screen is mostly empty black, with a dashed meter at the top, a lone dash under the blob, and two lines saying the same thing. It feels idle in a slightly broken way instead of attentive. With the extra dash removed and the island at rest showing dots, the blob alone would carry "I'm listening".
- **Talking:** not captured (TTS 503, fake mic). By design the blob reacts to real amplitude and the transcript keeps the current sentence bold, which is right.
- **Minimise (`19`):** reassuring. The call continues in the island with the timer.
- **End:** red end and the card folds into the island, so the turns stay in the thread. A good end state.

## Persona Red Flags
**Casey (Distracted Mobile User):** Talking while walking, Casey minimises the call to check a message. To mute (say, a bus announcement), Casey must tap the island, wait for the card to grow, then tap mute. There is no quick action on the minimised island. All controls are in the thumb zone, which is good.

**Sam (Accessibility-Dependent User):** Hears "스피커 끄기, 선택됨" and can't tell whether the speaker is on. The dialog is labelled "깽이와 통화", which is right for this name and wrong for a name with a final consonant. In dark mode the end button's glyph contrast drops to about 2.8:1.

**Jordan (Confused First-Timer):** Reads "듣고 있어요" at the top and "말씀하시면 깽이가 들어요" at the bottom and waits for something to start. Sees the bright white speaker disc and assumes it is the button to press.

**Project persona: The hands-busy talker, "준서"**
- *Profile (from PRODUCT.md Users and Operating Context):* non-technical; uses the phone one-handed in short bursts; expects 깽이 to talk like a capable person; turns can take seconds to minutes.
- *Behaviors:* starts a call from the composer, pockets the phone, glances back at the island, ends with a thumb.
- *Red flags:* the minimised island shows dashes and a timer but no word for "call"; a meter that looks like a loading bar during silence; a salmon end button at night.

## Minor Observations
- Call buttons are 68 px (`call.css:193-194`), and DESIGN's Shapes section says 64 px circles for call buttons. Pick one and update the other.
- `call-head-end` is an empty 44 px spacer that balances the grid (`CallOverlay.tsx:173`). Fine, but it means the name is centred on the card, not under the island's timer. Check alignment against the island at 402 px widths.
- When there is no transcript, the stage (`call.css:77-85`, `flex: 1 1 auto`) leaves a large black void between the blob and the hint. That is fixture-limited; with real captions the transcript block fills it. Re-check once TTS is on.
- The island's expanded call controls (`DynamicIsland.tsx:233-282`) are no longer reachable, because tapping the island reopens the card (`callStore.ts:325-338`). Either remove them or use them for the minimised quick actions Casey needs.
- `call.css:21` pads by `--chrome-top + 8px`, so the minimise chevron sits 86 px from the top: reachable, but in the hard-reach zone. Esc already minimises. A swipe-down on the card would help one-handed use; whether one exists was not checked.

## Engine and Theme Differences
- **Chromium vs WebKit:** pixel-equivalent on both screens. Same aliasing, same layout.
- **Light vs dark:** the card is black in both, as designed, but the end button changes from `#d70015` to `#ff6961`. In `19`, the dark top bar shows the avatar on its white disc right under the island's green avatar, so the two avatars stack.

## Questions to Consider
- If the blob is the voice, does the screen need any other meter? And could the island show only the timer while the card is minimised?
- Should a minimised call offer mute and end on the island itself, the way the unused expanded controls already could?
- Is "말씀하시면 깽이가 들어요" ever needed when STT works, or only when it doesn't?
- Should the call card follow the theme at all, or should it stay "island black" in both themes, with its own fixed tokens for fills and the end red?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 18, 19.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `low-contrast` | 2 | 18, 19 | 4.4:1 (need 4.5:1) — text #6e6e73 on #efeff0 | **True positive** (`.ccard-badge`): 4.4:1. Put the badge text in `label`. |
| `low-contrast` | 2 | 18, 19 | placeholder 1.9:1 (need 4.5:1) — text #afafb2 on #efeff0 | **Minor.** Every field has a visible label, so this is not blocking. Raise placeholders to about 3:1 (`#8e8e93`). |
| `low-contrast` | 2 | 18, 19 | 3.6:1 (need 4.5:1) — text #ffffff on #0a84ff | **True positive.** Every primary button fails: white on `#0A84FF` is 3.6:1 against the 4.5:1 needed at 17 px semibold. Fix it at token level: the button fill becomes the existing `--accent-text` `#0071E3`, which gives 4.7:1 (slop-inventory §2). |
| `low-contrast` | 2 | 18, 19 | 4.1:1 (need 4.5:1) — text #6e6e73 on #e6e6e9 | **True positive** (`.msg-event`): 4.1:1. Remove the pill and set the note as centred footnote text on the background (4.9:1), or use `label` on the fill. |
| `organic-clip-path` | 4 | 18, 19 | clip-path: path() with 12 curve segments; clip-path: path() with 16 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** contrast on the call screen: A flags the end button at about 2.8:1 in dark; B (light only) flags the primary-button fill elsewhere on the same screens.
- **B caught, A missed:** **[P1]** white on `#0A84FF` at 3.6:1 on primary buttons visible behind or around the overlay; the event-note pill (4.1:1) and the card badge (4.4:1) come from the thread underneath.
- **A caught, B missed:** silence reported four times; three different reds; mute/speaker labels flipping between action and noun.
- **False positives:** `organic-clip-path` (the glass union).

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- **Looked at:** `18` and `19` in chromium-light, chromium-dark and webkit-light; webkit-dark `18`. Source: `screens/chat/call/CallOverlay.tsx`, `call.css`, `callState.ts`, `callStore.ts` (notes, island link, voice turns), `app/DynamicIsland.tsx`, `app/DynamicIsland.css`, `app/island.ts` (press and call), `three/AgentBlob.tsx` (canvas settings), `styles/tokens.css` (`--danger`, `--island`).
- **Limits:**
  - Stills only: the circle → island → card morph, the fold-back and the level animation were not judged.
  - Media devices are fake, so the line is silent and no transcript appears. TTS is disabled (503), so the speaking state and captions were not seen.
  - Contrast ratios are computed from token hex values, not measured from pixels.
  - The detector and the slop inventory were not consulted (isolation rule).
