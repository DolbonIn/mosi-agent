Method: dual-agent (A: critique-a2 · B: impeccable detector over CDP, run by design-director)

# Critique: 둘러보기 (Explore: templates, category rail, pre-delegate sheet)

2026-11-12 · Mode: Operate · Screens: `22-explore`, `23-explore-scrolled`, `24-predelegate-sheet` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | The selected category gets the droplet and a bold label, the section header follows the category ("여행에서 많이 맡긴 일"), there are loading placeholders, and the sheet runs loader → check. |
| 2 | Match Between System and Real World | 2 | "17,166명이 맡겼어요" counts delegations, not people, and starts from invented numbers. "추천" actually shows everything. Template titles are written in the agent's first person, which is fine. |
| 3 | User Control and Freedom | 3 | Sheet close, drag-dismiss, connect buttons that push Connections. |
| 4 | Consistency and Standards | 2 | 23 template hues plus 7 category hues against an otherwise neutral app. Titles end with and without a period. The pre-delegate sheet mixes a hue plate with grey tiles. "초대" sits in the top bar of a screen that has nothing to do with inviting. |
| 5 | Error Prevention | 2 | The sheet shows needs, time and quota before committing (good), and disables 맡기기 when quota is out, with a note. But it tells the call demo "따로 연결할 건 없어요" when a verified phone number is required. |
| 6 | Recognition Rather Than Recall | 3 | Rows describe themselves; the category labels are plain words. |
| 7 | Flexibility and Efficiency of Use | 2 | No search across 23 templates, and no way to adjust a template before delegating. The category filter is the only shortcut. |
| 8 | Aesthetic and Minimalist Design | 2 | Rainbow plates, 3-line descriptions that restate the title, about 135 pt per row (three rows per screen), and five boxed regions in the sheet. |
| 9 | Help Users Recognize, Diagnose, and Recover from Errors | 3 | Inline errors, "다시 맡기기", and an out-of-quota note that names the fix (초기화 티켓). |
| 10 | Help and Documentation | 3 | The pre-delegate sheet *is* contextual help: steps with real sources (기상청, 국토교통부…), needs, time, cost and where the result lands. |
| | **Total** | **25/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** The content is very specific. Every template maps to a real capability: k-skill tools (기상청, KOPIS, LH, 국토교통부), messenger tools, 정부 지원사업 and Korean commute data. The pre-delegate sheet's idea ("what I'll do, what I need, how long, what it costs, where it lands") is a genuinely good, product-shaped pattern from MOTION-SPEC §8.9.

The presentation is the most generic screen in the app. A horizontal rail of pastel icon circles over a list of saturated rounded-square icon tiles, each followed by a bold title, a grey description and a social-proof line. That's the "app gallery" template; with the names covered, it could be any super-app's 서비스 tab. The rainbow tiles carry no information (the hue is arbitrary per template) and break both "one accent" and "hue plates only identify a third party". The social proof is fabricated. The one thing only 모시 can show here is its personal suggestions ("깽이의 제안", chosen by time of day, KakaoTalk status and empty schedules), and they're rendered last, below 23 rows.

**Deterministic scan.** Pending: Assessment B, joined by design-director.

## Overall Impression
Good bones, generated skin. The list is a proper inset group, rows are whole-row buttons, and the sheet tells the truth about cost and time. But the screen's loudest elements are decoration (30 arbitrary hues) and an invented crowd ("17,166명"). The best item, the personal suggestions, is buried. The biggest opportunity: make the list honest and quiet (no plates, real counts or none), and lead with 깽이's suggestions.

## What's Working
- **The pre-delegation sheet's content model.** Steps carry their real data source, needs offer a direct "연결하기", time and quota are labelled as estimates ("약"), and the last line says where the result lands ("다 만들면 보관함에 문서로 저장돼요"). "맡기기" is the screen's only accent (`PreDelegateSheet.tsx:96-108`, `templateInfo.ts:1-131`). This is "Nothing leaves without consent" applied to delegation.
- **A real iOS inset list.** One paper group, separators inset to the text column (72 px), the whole row as the button, a chevron as affordance, and a press tint with no colour (`explore.css:123-172`). The large title hands over to the top-bar capsule on scroll ("둘러보기" in `23`).
- **The category rail's selection model.** A neutral droplet behind the selected plate (`--surface` light / `--fill-3` dark), `role="tablist"` with roving `tabIndex` and arrow keys, a bold label on selection, and scroll-into-view honouring reduced motion (`CategoryRail.tsx:47-79`, `:81-113`).

## Priority Issues

**[P1] The crowd is invented: "17,166명이 맡겼어요"**
- **What:** Every template seed in the server carries a hard-coded `count` (17166, 7734, 5120…). On first seed it's written into `template_counts` and then incremented once per delegation. The app shows it as "N명이 맡겼어요", and the list is ordered by it, so the fake numbers also decide what's "요즘 많이 맡긴 일". On a fresh install, every number on the screen is fiction. Even the real increments count delegations, not people ("명").
- **Why it matters:** PRODUCT.md: "No testimonials, customer counts… Do not fabricate them (e.g. the explore template 'people count' must come from the server, not design copy)." Moving the invented number into server code doesn't make it true. The craft floor says the same ("claims come from supplied truth"). For an agent that asks users to trust it with calls and passwords, fake social proof is the most expensive kind of slop.
- **Fix:** Seed `count: 0` for every template and reset `template_counts`. Hide the count line until a template passes a real threshold, counted as distinct users server-side. Only then say "N명이 맡겼어요"; otherwise say nothing (not "N번"). Until real counts exist, order by the editorial `sort` and title the section truthfully: "맡길 수 있는 일" (and "{카테고리}에서 맡길 수 있는 일").
- **Evidence:** `22-explore`, `23-explore-scrolled` (all engines). `apps/server/src/explore.ts:41-338` (seed `count` values, e.g. `:51` 17166, `:63` 7734). `apps/server/src/db/index.ts:710` (seed written), `:716-723` (`ORDER BY count DESC`), `:734-738` (+1 per delegation). `apps/mobile/src/screens/more/format.ts:17` ("명이 맡겼어요"). `ExploreScreen.tsx:121`, `:129-134`.

**[P1] The top template promises a call to you, then asks for someone else's number**
- **What:** The first row and its sheet say "지금 바로 전화를 걸어요… 직접 들어 보세요", step "내 휴대폰으로 전화 걸기 · 걸기 전에 한 번 더 승인받아요", "필요한 연결: 따로 연결할 건 없어요", note "승인하면 바로 전화가 와요", CTA "전화 받아 보기". After 맡기기, the server opens a thread whose first message asks "누구에게 어떤 용건으로 전화할까요? 상대 번호와…". Calling the user also needs a verified number (나의 모시 › 내 전화번호), which `needsFor` never checks, so "따로 연결할 건 없어요" is false for most new users.
- **Why it matters:** This row is first in the list (because of its seeded 17,166). It's the first impression of the phone feature, and it breaks right after the user commits. Error prevention fails twice: wrong expectations, and a missing prerequisite reported as "nothing needed".
- **Fix:** (1) In `needsFor`, add a need for `call-demo` when `usePhone()` isn't verified: row "내 전화번호" with sub "인증해야 전화를 받을 수 있어요" and a neutral `Button tone="secondary" size="sm"` "인증하기" that calls `presentPhone`. (2) Align the thread opener with the promise (`CALL_DEMO_GREETING` → call the user's verified number via `sys_call_me`). See phone-delegation.md P1 for the copy.
- **Evidence:** `24-predelegate-sheet` (all engines). `templateInfo.ts:51`, `:78-98` (no phone need), `:122`. `PreDelegateSheet.tsx:136-147` ("따로 연결할 건 없어요"). `apps/server/src/explore.ts:39`, `:421-445`.

**[P2] Thirty decorative hues: rainbow tiles and pastel category plates**
- **What:** Each template row leads with a 44 px rounded-square plate in its own saturated hue (`hsl(h 72% 52%)`, white glyph, literal `r13`): blue phone, mustard coins, orange sun, cyan plane, green train, yellow speech bubble… The rail adds seven pastel circles with tinted glyphs (`hsl(h 92% 94%)` / `hsl(h 78% 40%)`), each from a fixed hue map. The sheet repeats the template plate at 52 px.
- **Why it matters:** DESIGN.md: "Icon tiles go… Hue plates stay only where they identify a third party", "One Voice", "The Agent Owns Its Colour". The hues carry no information: travel is cyan in one row and blue in the rail, and "문서" templates are blue for no reason. The tiles are the first thing the eye lands on in every row, ahead of the title that actually says what the task is.
- **Fix (motion and droplet unchanged):** Template rows: remove the `Plate` (`ExploreScreen.tsx:125`), let the title lead, and move the separator inset from 72 px to 16 px (`explore.css:141`). The KakaoTalk and Slack titles already name the service. Category rail: make `.cat-glyph` a neutral `--fill` circle with a `--label` glyph (`explore.css:68-82`) and delete the `HUE` map (`CategoryRail.tsx:15-16`, `:101`). Keep selection as today: the `--surface` droplet on two edges plus a bold label. Pre-delegate head: drop the 52 px plate (`PreDelegateSheet.tsx:114`) and let the lead paragraph span the width.
- **Evidence:** `22`, `23`, `24` (all engines; dark turns the pastels into muddy `hsl(h 38% 20%)` discs). `ExploreScreen.tsx:125`. `screens/more/parts.tsx:44-55`. `screens/more/more.css:10-22`. `CategoryRail.tsx:15`, `:101-106`. `explore.css:61-82`.

**[P2] The pre-delegate sheet is five boxes and an icon wall**
- **What:** Inside one opaque sheet: a hue plate; a recessed group "깽이가 이렇게 해요" whose rows each carry a 30 px grey icon tile; a second recessed group "필요한 연결" that, for this template, holds a single row saying nothing is needed; two recessed fact tiles side by side ("예상 시간 / 1분 안팎", "한도 사용 / 약 2% / 오늘 100% 남음"), the left one half empty; then a note. That's 4 recessed panels and 3 tiles in about 900 px of sheet.
- **Why it matters:** DESIGN.md's "No card inside a card" and the craft floor's "hero-metric template" are exactly this: two big-number tiles for "1분 안팎" and "약 2%". The useful information (what happens, what's missing, what it costs) is there, but boxed so evenly that nothing leads. 맡기기 ends up about 1,000 px below the sheet's title.
- **Fix:** Lead paragraph without the plate. Steps as plain numbered lines: the unused `.pre-step-no` style is already in `explore.css:226-233`; title `--t-subhead` 500, source in `--label-2` on the same line, no tile, no panel. Render "필요한 연결" only when `needs.length > 0`; when it shows, use rows on the sheet background with a hairline divider, keep the "연결하기" button, and keep the provider logo plate (a real third party). Collapse the facts into one `--t-footnote` `tabular-nums` line above the result note: "약 1분 · 한도 약 2% · 오늘 100% 남음". Result: one heading, one list, one line, one note, one accent.
- **Evidence:** `24-predelegate-sheet` (all engines). `PreDelegateSheet.tsx:113-189`. `screens/more/more.css:124-206` (`.more-sheet-rows` r18 recessed, `.more-sheet-row__icon` r9 tile, `.more-fact` r16 tiles). `explore.css:226-233` (unused step numbers).

**[P2] A wall of 23 rows, with the personal part buried**
- **What:** "추천" isn't a recommendation: it shows every popular template (23 rows) at about 135 pt each, with descriptions clamped at 3 lines that mostly restate the title ("매일 아침 7시 모닝 브리핑 보내 드릴게요" / "…매일 아침 7시에 한 번에 정리해 먼저 보내 드려요"). "깽이의 제안", the only section chosen for this user (time of day, KakaoTalk not connected, no schedules), renders after all 23 rows. The rail fits exactly five plates with no partial sixth, so 문화 and 집·생활 are invisible until you happen to swipe.
- **Why it matters:** Cognitive load: 23 undifferentiated choices is the "Wall of Options". The product's differentiator (an agent that knows you) is about 3,000 pt down. The hidden categories hurt discoverability for Jordan.
- **Fix:** Render the `explore-suggest` section above the popular list (`ExploreScreen.tsx:84-91` before `:63-82`). Clamp `.tpl-desc` to 2 lines (`explore.css:197`, `-webkit-line-clamp: 2`). Make the rail peek: `.cat-item { width: 64px }` (`explore.css:49`) so about 30 px of a sixth plate shows at 390 wide, with the existing right fade. Optionally make 추천 mean `category === "recommend"` plus suggestions, and add a "전체" category for the full list. That needs the same tablist, with one more plate.
- **Evidence:** `22`, `23` (three rows per screen). `ExploreScreen.tsx:38`, `:63-91`. `explore.css:38`, `:42-54`, `:191-200`. `apps/server/src/explore.ts:383-401` (suggestion logic).

## Cognitive Load
- Checklist failures: **4 of 8** (high, critical fix needed).
  - *Single focus:* the rail, a 23-row list and a suggestions list compete. There's no first thing to do.
  - *Chunking:* 23 rows in one group with no sub-grouping.
  - *Visual hierarchy:* every row has the same weight. The saturated tiles outweigh the titles, and the fake count line adds a third tier of noise.
  - *Minimal choices:* 7 categories (5 visible) plus 23 rows.
- Passes: grouping (one inset group), one thing at a time (the sheet isolates a single decision), working memory (the sheet restates everything), and progressive disclosure (details live in the sheet).
- Decision points with > 4 visible options: the category rail (7), the template list (23), and the pre-delegate sheet's six regions for one yes/no decision.

## Emotional Journey
- **Arrive (22):** colourful but anonymous. The first thing read is a big number of strangers, not anything about "me".
- **Browse (23):** monotony. Every row has the same shape and a different colour, and the descriptions repeat the titles. Scroll fatigue sets in long before the suggestions.
- **Decide (24):** reassurance is the right instinct: steps, needs, time, cost and where it lands. But the boxes make it feel like a terms sheet.
- **Commit (call demo):** the valley. "전화 받아 보기" leads to "누구에게 전화할까요?". The peak-end memory of 둘러보기 becomes "it didn't do what it said".

## Persona Red Flags
**Jordan (first-timer):** reads "17,166명이 맡겼어요" as proof and taps the top row. Sees "따로 연결할 건 없어요", taps "전화 받아 보기", and is asked for a stranger's number. Never discovers 문화 / 집·생활, because nothing peeks past 사람.

**Casey (one-handed, short bursts):** three rows per screen and 23 rows means a lot of thumb travel to reach "깽이의 제안". The sheet's CTA is in the thumb zone (good), but the sheet is long enough that the needs section, the part Casey must act on, sits mid-sheet, away from the CTA.

**Riley (stress tester):** delegates a template five times, sees the count rise by five, and correctly concludes "명" is false. On a fresh server, sees 17,166 before anyone has used the app. Checks quota: "약 2%" comes from a formula (`estimateTokens`), labelled as an estimate, which is honest. Opens the KakaoTalk template while disconnected: the sheet says "연결하지 않으면 대화 중에 로그인 정보를 물어봐요", which is honest and good.

**Project persona: "지은", who wants one chore done** (PRODUCT.md: non-technical, one-handed, short bursts, expects plain talk). She opens 둘러보기 to find "the thing that phones places for me". Red flags: the phone template promises a call to her rather than to a business; the screen's visual weight goes to colour and crowd numbers instead of what each task does for her; her own suggestions are at the bottom.

## Minor Observations
- Title punctuation is inconsistent: "…찾아 드릴게요." (period) vs "…만들어 드릴게요" (none) (`apps/server/src/explore.ts:56` vs `:116`). Pick no period, matching iOS list titles.
- The top bar shows four glass shapes on this screen (menu, name capsule, "초대", tab bar). "초대" is chat-contextual; `useTopBarRight(null)` on Explore brings it to three and matches DESIGN.md's ≤ 3 rule (`ExploreScreen.tsx:34`).
- `.cat-label` dims unselected labels with `opacity: .78` (`explore.css:86-94`). Use `--label-2` instead, so contrast is a token and not a blend.
- `.cat-glyph` and `.cat-droplet` give the rail plates paper shadows (`explore.css:76`, `:107`), and `.tpl-list` keeps the two-layer paper shadow in light (`explore.css:129`). DESIGN.md's Flat Paper rule: separate by value, and drop the shadows.
- Literal radii: plate `13`, sheet rows `18`, row icon `9`, fact tile `16` (`ExploreScreen.tsx:125`, `more.css:133`, `:173`, `:189`). These go away with the P2 fixes; any that remain should map to `--r-group` / `--r-tile`.
- The connect-kakao suggestion row shows "연결하면 바로 쓸 수 있어요" with a link glyph, which is good. It's the honest version of what the count line should be: a fact about the user, not a crowd.
- The sheet title is the full template sentence ("제 전화, 먼저 한번 받아 보실래요?"), centred at `--t-body` 600 between a blank 44 px column and ×. Long titles wrap to two centred lines. That's acceptable, but a left-aligned title over the lead would read better for sentence-length titles.
- The agent in these captures is pink, while chat and drawer show a green 깽이. That's a different fixture account, not a bug.

## Engine and Theme Differences
- **WebKit (`22`, `23`, `24`):** `text-wrap: pretty` produces shorter, raggeder description lines ("날씨와 가볼 만한 곳을 확인해 / 동선에 맞춘 2박 3일 일정을 문서로 / 정리해 보관함에 넣어 드려요."). Rows are slightly taller, so Safari shows fewer rows per screen than Chrome. The 2-line clamp in P2 evens this out.
- **Dark:** the pastel category plates become low-contrast brown, olive and navy discs (`hsl(h 38% 20%)`). The template tiles darken to `hsl(h 60% 46%)` but stay the loudest elements. The selected rail droplet is `--fill-3` with no shadow (good). The sheet's recessed panels use `--fill`, still four boxes.
- Chromium and WebKit agree on geometry otherwise. Both show the rail ending exactly at 사람 with no peek.

## Questions to Consider
- What would 둘러보기 look like if it were *only* 깽이's suggestions plus a search field, with the catalogue one tap deeper?
- If a count can't be real yet, is there a true signal to show instead: "카카오톡 연결 필요", "1분 안팎", "매일 받을 수 있어요"?
- Does "추천" mean "everything", "editor's picks" or "for you"? Choosing one would decide both the rail and the list order.
- Should the pre-delegate sheet let the user edit the prompt ("서울 말고 부산으로") before 맡기기, so the first agent turn isn't a clarifying question?
- Is the call demo meant to show "how 모시 sounds to others" (call me) or "try delegating a call" (call someone)? Today four surfaces say one thing and the thread says the other.

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 22, 23, 24.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `organic-clip-path` | 3 | 22, 23, 24 | clip-path: path() with 16 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |
| `low-contrast` | 1 | 24 | 3.6:1 (need 4.5:1) — text #ffffff on #0a84ff | **True positive.** Every primary button fails: white on `#0A84FF` is 3.6:1 against the 4.5:1 needed at 17 px semibold. Fix it at token level: the button fill becomes the existing `--accent-text` `#0071E3`, which gives 4.7:1 (slop-inventory §2). |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** nothing overlaps.
- **B caught, A missed:** **[P1]** the pre-delegate sheet's primary (전화 받아 보기) is 3.6:1.
- **A caught, B missed:** the invented N명이 맡겼어요 counts (fabricated social proof, which also set the sort order); the call-demo sheet's promise contradicting the thread; 30 decorative hues.
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- Assessment A only, isolated: I didn't read the slop inventory, any detector JSON or other critique files, and I didn't run the detector.
- Looked at: `22`, `23` and `24` in chromium-light, chromium-dark, webkit-light and webkit-dark. Source: `screens/more/explore/{ExploreScreen.tsx,CategoryRail.tsx,PreDelegateSheet.tsx,templateInfo.ts,explore.css}`, `screens/more/{parts.tsx,more.css,format.ts}`, `apps/server/src/explore.ts` (`TEMPLATE_SEEDS`, suggestions, delegate), `apps/server/src/db/index.ts` (template counts).
- Limits: stills only. The droplet's two-edge travel, the content swap between categories and the row → sheet morph were not judged. "깽이의 제안" was not captured (below the fold); its placement was read from source. Template data is real seed data; the count values are the seeds themselves on this fixture server. Quota "100% 남음" reflects a fresh account. The wallpaper was not critiqued.
- Rule names quoted from impeccable (Apache-2.0, © Paul Bakaus): the craft floor's "hero-metric template" and "claims come from supplied truth", the "Wall of Options" cognitive-load violation, the heuristics guide and the persona set.
