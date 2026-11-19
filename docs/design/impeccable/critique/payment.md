Method: dual-agent (A: critique-a3 · B: impeccable detector over CDP, run by design-director)

# Critique: 결제 (Payment methods)

2026-11-12 · Mode: Operate · Screens: `43-payment` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | It says plainly that this build can't connect a payment method. The title "아직 연결된 결제 수단이 없어요" first suggests the opposite (that one could be added). |
| 2 | Match System / Real World | 3 | Plain 해요체 throughout. "보안 금고" and "접근 기록" are product terms used without a pointer to where they live. |
| 3 | User Control and Freedom | 3 | Back is always there and nothing traps the person. The one button leaves for a different feature (저장된 로그인). |
| 4 | Consistency and Standards | 2 | Step 2 says "모시도" while step 3 says "깽이가". The note quotes a setting as "보내기 전에 묻기" when its real label is "다른 사람에게 보내기 전에 묻기". Icon tiles repeat the pattern being removed elsewhere. |
| 5 | Error Prevention | n/a | No input, no destructive action, nothing to get wrong on this screen in this build. |
| 6 | Recognition Rather Than Recall | 3 | The step titles are scannable. The closing note asks the person to remember where "정보 공개 범위" is and what the setting is called. |
| 7 | Flexibility and Efficiency | n/a | No task to accelerate: the screen has no function in this build (PRODUCT.md: real charging is undecided). |
| 8 | Aesthetic and Minimalist Design | 2 | An empty-state plate, four icon-tiled promises and a footnote for a feature that isn't there. Encryption is said three times, and paper casts a shadow. |
| 9 | Error Recovery | n/a | Static screen with no request and no error state. |
| 10 | Help and Documentation | 3 | Explains why nothing can be done and how it would work. The help is about a future feature rather than this screen. |
| | **Total** | **19/28** | **Acceptable** (68 %) |

## Design Specificity Verdict
**LLM assessment.** The best decision here is product-specific and brave: no fake "카드 추가" button. The screen says the build can't do it, and that the agent won't pay on the person's behalf (`PaymentScreen.tsx:12-15, 25`). That matches principle 2 and the brand's "no marketing claims". Everything below that line is generic. A centered card glyph on a grey circle, then a four-row "here's how we keep you safe" list with lock / shield / check / eye tiles, is the security-features block of every fintech landing page. It describes an undecided feature (PRODUCT.md: "Payments … real charging is not decided") in the present tense and with more visual weight than the honest sentence above it.

**Deterministic scan.** Pending: Assessment B is joined by design-director.

## Overall Impression
A small, honest screen that over-explains. The person arrives from 나의 모시 to add a card, learns in one sentence that they can't, and is then given four promises, a footnote and a link to a different feature. The biggest opportunity is to let the honest sentence lead and shrink the rest to what is true today. Every outbound action, a payment included, waits for a device-signed approval. That one line is the product's real commitment, and it fits in one row.

## What's Working
- **No fake affordance.** There is no add-card button, no disabled form and no "coming soon" teaser. The empty state says "이 버전에서는 결제 수단을 연결할 수 없어요. 깽이가 대신 결제하는 일도 하지 않아요." That is exactly principle 2's voice.
- **Correct agent naming where it uses the helper.** The body and step 3 use `josa(agentName, "이가")` (`PaymentScreen.tsx:25, 37`), so "깽이가" is right for any name with or without a final consonant.
- **Restraint with the accent.** The one action is a neutral capsule. There is no blue on a screen with nothing to do, which follows the One Voice rule.

## Priority Issues

**[P2] The empty state frames "not available" as "not added yet", and its one action points elsewhere**
- **What:** The empty state reads "아직 연결된 결제 수단이 없어요" over a 64 px card glyph on a `--fill` circle. The body then says it can't be done in this build. The only button is "저장된 로그인 보기", which opens the vault.
- **Why it matters:** "아직 … 없어요" is the app-wide pattern for "you haven't added one" (보관함 uses it the same way), so the person looks for the add control before reading on. The vault link makes sense only after reading step 1 ("저장된 로그인과 같은 방식이에요"). As the empty state's sole action, it reads as a non sequitur. The plate is the Direction's "empty-state glyph" removal.
- **Fix:** Title: "결제 수단은 아직 연결할 수 없어요". Body: keep "깽이가 대신 결제하는 일도 하지 않아요." and drop the now-redundant first sentence. Render the empty state without its plate (an `EmptyState` variant with no `icon`, or `icon` made optional). Move "저장된 로그인 보기" to sit under the step that mentions saved logins, where its relevance is visible. If MOTION-SPEC §8.14's "one real action" must hold here, keep it in place but label it by its purpose: "로그인 정보는 어떻게 지키는지 보기".
- **Evidence:** `43` (all engines and themes). `PaymentScreen.tsx:22-31`, `ui/EmptyState.css:10-19`.

**[P2] Four promises for an undecided feature, encryption said three times, and the name drifts**
- **What:** The section "결제 수단이 생기면 이렇게 지켜요" lists four rows: 기기에서 잠가요 (encrypted on the device), 보안 금고에서만 열려요 ("서버 운영자도, 모시도 카드 번호 원문을 볼 수 없어요"), 결제할 때마다 물어봐요, 모두 기록에 남아요. A separate note follows about the "보내기 전에 묻기" setting. Rows 1 and 2 are the same promise. Row 2 names "모시" and row 3 names "깽이". The note quotes a setting label that doesn't exist as written (it is "다른 사람에게 보내기 전에 묻기", under 정보 공개 범위).
- **Why it matters:** DESIGN's "Say it once" and the brand's "no marketing claims". A present-tense feature list for something PRODUCT.md marks as open reads like a commitment the team hasn't made. The name drift makes the person wonder whether "모시" and "깽이" are two different parties. The footnote is a memory bridge to another screen, through a label that won't match what they find there.
- **Fix:** Collapse to three plain rows. (1) "카드 정보는 이 기기에서 암호화돼요. 서버 운영자도 깽이도 원문을 볼 수 없어요." (rows 1 + 2, agent name through the helper). (2) "결제할 때마다 금액과 가게를 보여 드리고, 직접 확인한 다음에만 결제해요. 정보 공개 범위 설정과 관계없이 항상 물어봐요." (row 3 + the note, which removes the footnote). (3) "언제 어디에 썼는지 접근 기록에서 볼 수 있어요." Section label: "결제 수단을 연결할 수 있게 되면" (conditional, matching the open decision). Use `<ul>`, not `<ol>`: these are not sequential steps.
- **Evidence:** `43`. `PaymentScreen.tsx:32-41`, `PaymentScreen.tsx:36` ("모시도"), `PaymentScreen.tsx:41`, `settings/PrivacyScreen.tsx:73` (the real label).

**[P2] Icon tiles and a shadowed paper card carry the list**
- **What:** Each row has a 34 px r10 `--fill` tile (lock, shield, checkmark, eye) beside a 17/600 title and a 15 px body. The list is a `.paper` card with the light-mode two-layer shadow.
- **Why it matters:** These are the Direction's icon tiles and "Paper is flat". The check glyph for "물어봐요" and the eye for "기록" are guesses that add nothing the titles don't say.
- **Fix:** Remove `.pay-step__icon` (`PaymentScreen.tsx:50-52`, `payment.css:20-28`). Rows are title + body on paper, separated by hairlines (`box-shadow: inset 0 1px 0 var(--separator)`) with 14 px between them. The paper card drops its shadow in light mode (`ui/Card.css:9`, system-wide per the Direction).
- **Evidence:** `43` (all). `PaymentScreen.tsx:47-58`, `payment.css:10-28`.

**[P3] The first viewport cuts the explanation mid-sentence**
- **What:** At 390×844 the 40 px empty-state padding, the 64 px plate and a two-line body push the list down. The tab bar cuts row 3 mid-sentence ("깽이가 금액과 가게를 보여 드리고, 직접 확인한" in Chromium). In WebKit, where the body wraps to three lines, only two rows are visible.
- **Why it matters:** The one row that states the product's real commitment (approval before any payment) is the one hidden under the tab bar.
- **Fix:** This follows from the issues above: no plate, a one-sentence body and three rows. With them, the whole screen fits above the tab bar in both engines. Also set the empty-state measure in `em` (see Engine differences).
- **Evidence:** `43` chromium-light vs webkit-light. `ui/EmptyState.css:7, 29`.

## Cognitive Load
- **Checklist failures (2, moderate):** *Working memory*: the note relies on remembering where "정보 공개 범위" is and what its setting is called. *Progressive disclosure*: four rows about how an unavailable feature would work are shown up front, before the person needs them.
- **Decision points with >4 visible options:** none. There is one action.

## Emotional Journey
The person arrives with an intent (add a card). The large title "연결된 결제 수단" and the empty-state title suggest it is possible, then the body says it isn't. That is a small letdown, softened by the honesty of "깽이가 대신 결제하는 일도 하지 않아요". The emotional peak should be relief ("nothing will be charged without me"). Instead the screen keeps reassuring about a feature that doesn't exist, and ends, cut by the tab bar, mid-sentence on the line that matters. A shorter screen ends on the strongest true sentence.

## Persona Red Flags
**Jordan (First-Timer):** He reads "아직 연결된 결제 수단이 없어요" and looks for 추가. He finds "저장된 로그인 보기" and taps it, assuming it is how to add a card, then lands in the vault confused. He reads "모시도" and "깽이가" as two different parties.

**Riley (Stress Tester):** She checks the note's claim. Searching 정보 공개 범위 for "보내기 전에 묻기", she finds "다른 사람에게 보내기 전에 묻기". The UI quotes its own setting wrongly. She asks what exactly "모두 기록에 남아요" records for a payment that can't happen, and where.

**Project persona: Cautious delegator "영숙"** (PRODUCT.md: non-technical; high-stakes moments include "approving … a payment"; nothing leaves without device-signed approval). *Red flags:* The one promise she cares about ("I will be asked every time") is the third of four rows and is cut off by the tab bar on first view. Three rows about encryption read like the app protesting too much about something it can't do yet.

## Minor Observations
- The large title "연결된 결제 수단" is the profile row's label. Over an empty, unavailable screen, "결제 수단" alone would be less presumptive. The title is a route literal, so the change belongs with the profile row.
- Literal radius `.pay-step__icon` 10 (`payment.css:26`) goes with the tile.
- Section label padding is fixed here (`payment.css:7-9`), and the note's padding comes from a cross-file selector in `more.css:230` (`.pay-how + .more-note`). If the note is folded into row 2, that selector can go.

## Engine and Theme Differences
- **Measure:** the empty-state body wraps at about 260 px in Chromium (2 lines) and about 195 px in WebKit (3 lines), from `max-width: 28ch` (`ui/EmptyState.css:29`) resolving differently. WebKit therefore pushes the list about 46 px lower. An em-based Hangul measure (e.g. `max-width: 17em`) behaves the same in both.
- **Dark:** the tiles and plate become near-black squares on near-black paper and add even less. The paper card uses its hairline, which is good. The avatar dot sits on a white disc in the name capsule (shared chrome).

## Questions to Consider
- Until charging is decided, should this row exist in 나의 모시 at all, or should it live as one line in 정보 공개 범위 ("결제와 송금은 항상 확인받아요")?
- If the screen stays, is "how we'd protect a card" the right content, or is "what 깽이 will do when a task needs payment" (stop and ask you to pay yourself) the more useful truth today?
- What is the smallest version of this screen that is still true when payments ship? Could that version ship now?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 43.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `skipped-heading` | 1 | 43 | <h1> "보관함" followed by <h3> "11월 12일 주간회의 회의록" (missing h2) | **True positive.** `SectionLabel` renders `<h3>` straight after the page `<h1>` (`screens/more/parts.tsx:93`), so VoiceOver's heading rotor skips a level. Make it `h2`. |
| `organic-clip-path` | 1 | 43 | clip-path: path() with 12 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** nothing overlaps.
- **B caught, A missed:** **[P2]** heading skip `<h1>` → `<h3>` (결제 수단이 생기면 이렇게 지켜요).
- **A caught, B missed:** an empty state that implies an add path, with its only action going to the vault; four present-tense promises for a feature that is undecided; icon tiles; the key row cut off by the tab bar.
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- Looked at: chromium-light, chromium-dark, webkit-light and webkit-dark for `43`. Read `PaymentScreen.tsx`, `payment.css`, `parts.tsx` / `more.css`, `ui/EmptyState.css`, `ui/Card.css`, and checked the referenced setting label in `settings/PrivacyScreen.tsx:73`.
- Limits: stills only, one screen, and the screen is static (no request, no states). That is why heuristics 5, 7 and 9 are `n/a` and the total is over 28. PRODUCT.md marks real charging as open, so fixes keep the "not available" stance and avoid new promises. Detector not run (isolation rule). Nothing under `apps/` was modified.
