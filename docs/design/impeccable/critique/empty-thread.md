Method: dual-agent (A: critique-a1 · B: impeccable detector over CDP, run by design-director)

# Critique: 빈 대화와 제안 (Empty conversation and suggestions)

2026-11-12 · Mode: Operate · Screens: `05-chat-welcome`, `06-chat-welcome-briefing`, `07-chat-empty-thread` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | A tapped suggestion becomes a bubble in the same frame, and a picked chip turns selected. The welcome opens scrolled to its end, with nothing to say the greeting is above. |
| 2 | Match Between System and Real World | 3 | Warm, concrete 해요체 ("오늘 날씨와 미세먼지를 알려 드려요"). Two misses: the `coins` glyph reads as a database cylinder, and the friend empty state says "모시도 대화에 들어와요" about the agent. |
| 3 | User Control and Freedom | 3 | Suggestions send at once, so they can't be adjusted first ("내일 날씨" → "부산 내일 날씨"). Stop and retry still apply afterwards. |
| 4 | Consistency and Standards | 2 | The same job (showing what to ask) has two unrelated designs: a card of rows plus chips, and a centred glyph over pills. "알려 줘" and "알려줘" are both used. The chevron leads its label. |
| 5 | Error Prevention | 3 | After one pick, the other send-chips disable, which prevents double sends. It also over-reaches (see P2). |
| 6 | Recognition Rather Than Recall | 3 | Everything 모시 can do is visible on first run. Nothing has to be remembered. |
| 7 | Flexibility and Efficiency of Use | 2 | The welcome menu is one-shot: after the first pick the other three tasks grey out. The empty-thread suggestions can't be edited before sending. |
| 8 | Aesthetic and Minimalist Design | 2 | Four rows repeated as four chips. Icon plates. A sparkles glyph on a shadowed tile. A security reassurance before any secret is asked for. |
| 9 | Error Recovery | 3 | Inherits the thread's failed-bubble row ("보내지 못했어요 · 다시 보내기"). Nothing specific to this surface fails visibly. |
| 10 | Help and Documentation | 3 | The welcome card is the help: a task-shaped list of what to delegate, in the place where you delegate. |
| | **Total** | **27/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** The welcome copy is specific to this product. "날씨·교통·정부 지원사업 찾기부터 문서 만들기, 메신저 정리까지" and the four rows (미세먼지, 정부 지원사업, 카카오톡, 아침 브리핑) could only belong to a Korean-life agent.

The forms around that copy are stock. Under the welcome sits a card with icon plates and a cloud of grey chips. The empty thread is the most generic screen in the app: a sparkles icon on a white rounded tile with a drop shadow, a "waiting" headline, and three centred grey pills ("내일 날씨 알려 줘", "이번 주 할 일 정리해 줘", "점심 메뉴 골라 줘"). Those pills would fit any chatbot. Two of the three show nothing 모시 does that other assistants don't.

The biggest missed opportunity: the headline says "깽이가 기다리고 있어요", yet 깽이 is not on the screen. DESIGN reserves personality for the agent character, and here a generic AI glyph stands in its place.

**Deterministic scan.** See Assessment B.

## Overall Impression
First-run is where the product introduces its agent, and both screens hide it. On the welcome, the greeting "안녕하세요, 하늘 님! 저는 깽이예요." sits above the fold under the top bar, so the person lands mid-sentence. On the empty thread, the agent is replaced by sparkles. The single biggest opportunity is to show the agent and let one list do the work. Fit the welcome on one screen, make the four rows the actions, and put 깽이 itself where the sparkles tile is.

## What's Working
- **Concrete, Korean-specific capability copy.** The seeded card (`apps/server/src/auth.ts:136-145`) promises outcomes in plain 해요체: "지금 신청할 수 있는 정부 지원사업을 찾아 드려요", "매일 아침 브리핑을 먼저 보내 드려요". No hype, no exclamation marks in the card.
- **Correct josa on the agent's name.** "깽이가 기다리고 있어요" is built with `josa(agentName, "이", "가")` (`EmptyThread.tsx:26`), so a user-chosen name with a final consonant reads correctly. That is Principle 5 in practice.
- **Zero-typing first action.** One tap sends the suggestion, and the bubble appears in the same frame (`EmptyThread.tsx:31`, `InfoCards.tsx:59-66`). For a one-handed first run, that is the right amount of effort.

## Priority Issues

**[P1] A new account opens mid-sentence: the greeting is hidden under the top bar**
- **What:** The main thread starts pinned to its end (`ThreadView.tsx:174-177`: the first page sets `scrollTop = scrollHeight`). The seeded welcome has three paragraphs (`auth.ts:150`) and a card with four rows plus four chips (`auth.ts:136-145`). Together they are taller than the space between the top bar and the composer, so the first frame shows "…주세요. 날씨·교통·정부 지원사업…" with the first line fading under the capsules. "안녕하세요, 하늘 님! 저는 깽이예요." is never on screen unless you scroll up. `05` and `06` are identical captures because the list cannot scroll any further toward the card.
- **Why it matters:** This is the product's first sentence and the agent's self-introduction. Peak-end works both ways: starting mid-sentence makes the very first impression look broken.
- **Fix:**
  - Make the welcome fit one screen. Drop the third paragraph (the reassurance, see P2) and replace the card's chip block with tappable rows (see the next issue). My estimate from the stills: about 150 px is hidden, and those two cuts recover about that much.
  - In `ThreadView.tsx:174`, when the thread holds only the seeded welcome (one assistant message, no user message), position the first message's top at the scroll edge instead of pinning to the end.
- **Evidence:** `chromium-light-05/06`, `chromium-dark-05/06`, `webkit-light-05/06`. `ThreadView.tsx:170-183`, `auth.ts:136-150`.

**[P1] The welcome card lists four tasks, then lists them again as chips, and only the chips do anything**
- **What:** "이런 일을 맡겨 보세요" renders four rows, each an icon plate plus a sentence (`InfoCards.tsx:39-48`, `cards.css:73-102`). The rows are plain `<li>` elements, not controls. Below them, four chips repeat the same four tasks as the actual buttons ("오늘 날씨 알려줘", "지원사업 찾아줘", "카카오톡 연결하기", "모닝 브리핑 예약", `InfoCards.tsx:49-69`). That is eight items for four choices. The open-type chip puts its chevron before the label ("> 카카오톡 연결하기", `InfoCards.tsx:56`), a web pattern rather than an iOS one.
- **Why it matters:** DESIGN: "Chips only where a choice is offered… Uniform grey pills that repeat the rows above them (briefing quick replies)… are rewritten as rows." The decision point shows eight targets against a working-memory limit of four, and a first-timer naturally taps the row they just read, which does nothing.
- **Fix:**
  - Make each row the button: `min-height: 54px`, full-width press tint, row text in `--t-subhead`, label colour.
  - `send` rows take no trailing glyph. The `open` row ("카카오톡 연결하기") takes a trailing `chevron-right` at 16 px in `--label-3`.
  - Delete the quick-replies block for briefing cards whose items all carry an action, and remove the 32 px plates (`cards.css:87-96`). If a glyph stays, it sits inline at text size in `--label-2`.
  - Note: MOTION-SPEC §8.7 still describes briefing as rows plus quick-reply chips. DESIGN's Direction is newer and is the brief.
- **Evidence:** `05`, `06` (all engines and themes). `InfoCards.tsx:39-69`, `cards.css:73-107`, `auth.ts:139-144`.

**[P2] The empty thread's hero is a sparkles icon on a shadowed tile**
- **What:** `EmptyThread.tsx:23-25` renders `sparkles` inside a 56 px white plate with a two-layer shadow and an 18 px literal radius (`chat.css:816-826`). The headline below it names the agent ("깽이가 기다리고 있어요").
- **Why it matters:** This one element breaks four DESIGN rules: "No AI-cliché glyphs", "Icon tiles go", "Paper is flat", and the Token Radius Rule (18 is not on the scale). It also misses the one thing this screen should show: DESIGN says the agent character is the single expressive element, and this headline talks about it.
- **Fix:** Replace the plate with the agent's own avatar: `<Avatar spec={agent.avatar} size={56} breathing={false} />` with no plate and no shadow. Idle is still, so there is no breathing on an empty screen. Keep the title and body. Friend threads keep a neutral `people` glyph inline at 28 px with no plate.
- **Evidence:** `chromium-light-07`, `chromium-dark-07`, `webkit-light-07`, `webkit-dark-07`. `EmptyThread.tsx:23-25`, `chat.css:816-826`.

**[P2] Suggestions are chips standing in for a list, they send before they can be adjusted, and the welcome menu dies after one tap**
- **What:**
  - *Layout.* The three empty-thread suggestions are centred pills of different widths stacked one per line (`EmptyThread.tsx:28-34`, `chat.css:838-844`). That is a list drawn as chips.
  - *Send at once.* They send immediately (`EmptyThread.tsx:31`). MOTION-SPEC §8.14 says an empty state "puts an example prompt into the composer and navigates there".
  - *One-shot menu.* On the welcome card, picking one send-chip permanently disables the other send-chips (`InfoCards.tsx:58`, `picked !== null && !!a.send && picked !== a.label`). The memory is an in-memory `Map` (`InfoCards.tsx:16`), so after a reload they are enabled again.
- **Why it matters:** "Don't use chips for lists… or prose" (DESIGN). The four welcome tasks are independent, so asking for the weather should not cancel the 지원사업 search. A menu that greys itself out and then un-greys after a reload is inconsistent state.
- **Fix:**
  - Render the suggestions as three left-aligned plain rows in the content column, 44 px each, `--t-callout`, `--label`, with a 0.5 px `--separator` between rows. No fill, no stagger.
  - A tap fills the composer and focuses it through the existing focus request (`composerStore` `focusSeq`, `Composer.tsx:77-91`), as §8.14 specifies.
  - Welcome rows stay enabled after a pick; each is its own task.
  - Normalise the spacing to "알려 줘", "찾아 줘", "정리해 줘".
- **Evidence:** `07` (all engines), `05`. `EmptyThread.tsx:13-16`, `28-34`. `InfoCards.tsx:16`, `58`. `chat.css:838-844`.

**[P2] The first message says the security promise before any secret is asked for, and the brand stands in for the agent**
- **What:**
  - *Premature promise.* The seeded welcome ends with "비밀번호나 카드 번호는 휴대폰에서 암호화되어 저도 볼 수 없으니 안심하세요." (`auth.ts:150`). The same promise then returns, reworded, in the credential reply and in the card footnote (`chat.md`, P2).
  - *Brand for agent.* The friend empty state reads "@깽이를 붙이면 모시도 대화에 들어와요." (`EmptyThread.tsx:27`). In one sentence it names the agent and then calls it by the app's brand.
- **Why it matters:** DESIGN's "Say it once… it stays only beside the password field" and PRODUCT Principle 3 ("once, where it matters"). On a first screen, "안심하세요" before anything risky happens reads as boilerplate. Mixing 모시 and 깽이 teaches a new user that there are two agents.
- **Fix:**
  - Delete the third sentence from the welcome text in `auth.ts:150`; the promise lives in the credential field's hint.
  - Friend body: "@깽이를 붙이면 대화에 들어와요" (agent name via `josa`; no brand).
- **Evidence:** `05`, `06`. `auth.ts:150`, `EmptyThread.tsx:27`.

## Cognitive Load
Checklist failures (3, moderate):
- **Single focus:** fails. The first frame starts mid-sentence, so the reader's first job is to find the beginning.
- **Visual hierarchy:** fails. Rows and chips carry the same information at similar weight, and nothing says which ones are tappable.
- **Minimal choices:** fails. The welcome card shows 8 items for 4 choices.

Passing: chunking (four rows), grouping, working memory, progressive disclosure, one thing at a time.

Decision points with >4 visible options: welcome card (8 visible, 4 actionable).

## Emotional Journey
- **Arrival (`05`):** the person expects to meet the agent they just named. What they get is a paragraph that starts with "주세요." under a glass bar. Mild confusion right at the peak moment.
- **Discovery (the card):** competent and concrete; the copy builds confidence. The doubled rows and chips then make them wonder which part to tap.
- **First action (chip tap):** satisfying. The bubble appears at once.
- **Empty thread (`07`):** neutral and generic. "깽이가 기다리고 있어요" is warm, but the sparkles tile makes it read like every other AI app, and the suggestions (점심 메뉴) don't show what this agent is for.
- **Reassurance:** "안심하세요" arrives before there is anything to be anxious about. The valley it means to fill hasn't happened yet.

## Persona Red Flags
**Jordan (Confused First-Timer):** Lands mid-sentence and scrolls the wrong way to find the start. Taps the row "오늘 날씨와 미세먼지를 알려 드려요", which is not a button, and nothing happens. Then taps the chip "오늘 날씨 알려줘", and three chips grey out with no explanation. Reads "모시도 대화에 들어와요" in a friend thread and wonders who 모시 is.

**Casey (Distracted Mobile User):** The welcome's useful part (the chips) sits at 1180–1315 px of 1688 in the 2× capture, so it is reachable by thumb. But Casey picks the weather, gets interrupted, comes back to 지원사업, and finds it greyed out. On the empty thread, a suggestion sends at once, so a mis-tap while walking fires a request Casey didn't mean.

**Sam (Accessibility-Dependent User):** The four rows are a list of non-interactive text, followed by a `role="group"` of four buttons labelled "빠른 답" with the same content. A screen reader reads everything twice. The chips disabled after a pick are native `disabled` buttons with no description of why, so they read as broken.

**Project persona: The first-day delegator, "지은"**
- *Profile (from PRODUCT.md Users and Brand Commitments):* non-technical; just named her agent; one-handed; expects it to "talk like a capable person, not like software".
- *Behaviors:* reads the first lines only, taps the first thing that looks like an answer, leaves within a minute.
- *Red flags:* the agent's introduction is hidden; the empty thread's hero is a generic AI icon, not the agent she named; "안심하세요" before anything happened sounds like a terms-of-service banner; three of four tasks lock after her first tap.

## Minor Observations
- The `coins` glyph (`ui/Icon.tsx:307-312`) is two stacked ellipses and reads as a database. The `kakao` glyph is a generic speech bubble, not the KakaoTalk mark. Both are more reasons to drop the plates.
- `thread-empty-body` has `max-width: 28ch` (`chat.css:836`) while the title is unbounded. At 390 px both fit on one line, so the cap does nothing here. Check it at larger text sizes.
- `padding: 18vh 12px 24px` (`chat.css:814`) puts the block in the upper-middle. With the agent avatar instead of the tile, re-centre it optically (about 16vh) so the avatar sits above the visual centre.
- The 30 ms stagger on suggestions (`EmptyThread.tsx:30`) is an entrance on every visit to an empty thread. MOTION-SPEC §8.2 forbids re-entrance only on returns. Make sure the stagger plays on first mount only, not on tab revisit.
- Server copy uses "휴대폰에서" while the client uses "기기에서" and "이 기기에서". Pick "이 기기에서" everywhere.

## Engine and Theme Differences
- **Wrapping:** WebKit breaks the welcome's second line before "맡겨" ("…귀찮은 일을 / 맡겨 주세요.") where Chromium breaks after it. The meaning is the same, but the hidden first line differs slightly. Otherwise layout is identical across engines.
- **Dark:** the sparkles tile loses its shadow and turns into a dark plate with no visible edge, so it floats on nothing. The avatar in the top bar sits on a white disc (`ui/Avatar.tsx:89`). Chips use the dark `--fill` correctly.
- **No engine-specific bugs** on these three screens.

## Questions to Consider
- What if the welcome were just two sentences and four tappable rows, with nothing else? Would anyone miss the chips?
- Should the empty-thread suggestions show what only 모시 does (call a business, read 카카오톡, join a meeting), even if one of them needs a connection, instead of 점심 메뉴? This changes copy meaning, so it is the product owner's call, not the draft team's.
- Should the empty thread's one visual be the agent itself, as a still 56 px avatar, so the screen shows the thing its headline names?
- Is "기다리고 있어요" the right posture for an agent that "does things"? Or is the body line ("말로 맡기면 알아서 찾아보고 정리해 드려요.") enough on its own, under the agent's name?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 05, 06, 07.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `organic-clip-path` | 6 | 05, 06, 07 | clip-path: path() with 12 curve segments; clip-path: path() with 16 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** nothing overlaps. The detector found only quality rules here.
- **B caught, A missed:** nothing beyond the global glass-union false positive.
- **A caught, B missed:** the greeting hidden under the top bar on first open; the welcome card's rows and chips duplicating each other; the sparkles icon tile in the hero slot (impeccable's `icon-tile-stack` tell, which B didn't match because the glyph sits in a `span` with no heading sibling).
- **False positives:** `organic-clip-path` (the glass union).

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- **Looked at:** `05`, `06`, `07` in chromium-light, chromium-dark and webkit-light; webkit-dark `07`. Source: `screens/chat/EmptyThread.tsx`, `chat.css` (thread-empty), `cards/InfoCards.tsx` (BriefingCard), `cards/cards.css`, `ThreadView.tsx` (initial positioning), `Composer.tsx` (focus request), `ui/Chip.tsx`, `ui/Icon.tsx`, `ui/Avatar.tsx`, and `apps/server/src/auth.ts` lines 130–156 (seeded welcome and card).
- **Limits:**
  - Stills only, so the chip stagger and the selected-state morph were not judged.
  - `05` and `06` are identical captures: the capture's scroll-into-view could not move a list that was already at its end.
    Re-captured on 2026-11-12 from HEAD b3c2629: `06` is now the card right after the first pick ("오늘 날씨 알려줘").
    The picked chip is selected, the other two send chips are disabled, and the reply shows "생각하는 중". That frame is
    the evidence for P2-2's one-shot menu. The send is held in the browser, so no request reaches the server.
  - The "≈150 px hidden" figure is estimated from the 2× stills, not measured.
  - The welcome is real server output; the empty thread is a real empty thread.
  - The detector and the slop inventory were not consulted (isolation rule).
