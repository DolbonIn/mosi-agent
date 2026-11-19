Method: dual-agent (A: critique-a4 · B: impeccable detector over CDP, run by design-director)

# Critique: 나의 모시 (My 모시: profile, agent settings, usage and tickets, account)

2026-11-12 · Mode: Operate · Screens: `29-profile`, `30-profile-scrolled`, `31-profile-bottom`, `32-tickets-sheet`, `34-agent-settings`, `35-agent-settings-scrolled`, `36-account` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Quota shows % and a live reset countdown ("1시간 47분 뒤"). Rows show their state (없음, 2개 켜짐, 시스템 따름, 등록 안 됨). The ticket button runs loader → check only after the server answers. Gap: the two ticket counts have no visible names. |
| 2 | Match Between System and Real World | 3 | Warm, plain 해요체 almost everywhere. Developer language leaks in: a raw model id on 내 계정, "토큰" as the usage unit, "키 필요", and API names in the skill blurbs (초단기실황, NEIS, PM10·PM2.5). |
| 3 | User Control and Freedom | 3 | Back, ×, drag-to-dismiss, two-step logout, two-step memory delete. Gap: a colour or persona edit is silently thrown away if you go back without saving. |
| 4 | Consistency and Standards | 2 | Seven different container treatments on one tab, three plate sizes and radii, two heading sizes on the paired quota and usage cards, a dark hairline on cards but not on list groups, and a black selected radio while every other "on" state is blue. |
| 5 | Error Prevention | 3 | Name capped at 12 characters with an inline message, a 300-character counter, the last skill can't be switched off, and the ticket button is disabled with a stated reason. Gap: nothing guards unsaved agent edits. |
| 6 | Recognition Rather Than Recall | 3 | Current values sit on every row. Basic and premium tickets are told apart by hue alone. |
| 7 | Flexibility and Efficiency of Use | 2 | The hub is a single path. 21 skill toggles have no group control. There is no way to search or jump within settings. |
| 8 | Aesthetic and Minimalist Design | 2 | An icon plate on every row, drop shadows on paper, two ticket hues outside the palette, a privacy card sized like a promo banner, and the agent's name four times in one viewport. |
| 9 | Help Users Recognize, Diagnose, and Recover from Errors | 3 | The server's Korean message appears next to the control that failed (InlineError), with "다시 시도하기". Skill toggles roll back with an island banner. Inputs are kept. |
| 10 | Help and Documentation | 2 | The privacy explainer and the ticket note are good contextual help. The tab has no 도움말 or 문의 entry anywhere. |
| | **Total** | **26/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** This is mostly category-generic, with one element that is clearly 모시's own. The skeleton (large title, a stats card, a "your data is safe" card, then inset grouped rows with an icon plate on each) is a template that any iOS subscription app could ship unchanged. The authored parts are:
- the agent card, carrying the user's own blob;
- the hue swatches on the agent screen, which recolour that blob as you tap;
- the quota-plus-ticket mechanism;
- the connections card, which names 카카오톡 and 슬랙.

Those are the right places to be specific. Everything around them should get quieter so they can carry the screen. The most 모시-specific fact this feature owns, the agent's state ("쉬는 중", "마지막으로 일한 때"), is buried at the bottom of agent settings instead of being on the hub.

**Deterministic scan.** See Assessment B below.

## Overall Impression
The bones are good: native iOS structure, a real large title, honest states, and copy that explains consequences in one plain sentence. The surface carries the generated-UI residue the brief names: plates beside every label, paper with drop shadows, decorative hues, and a trust card that shouts. The biggest opportunity is a single list vocabulary across the tab: flat paper, glyphs in the text flow, one radius, one heading style. The hub would then read as calm iOS settings, and the agent card would be the only expressive object on it.

## What's Working
1. **Consequence-first copy.** "로그아웃해도 대화와 저장된 로그인은 지워지지 않아요. 다시 로그인하면 그대로 이어져요." "티켓을 쓰면 오늘 사용량이 바로 0%로 돌아가요. 매일 새벽 4시 초기화는 그대로예요." Each line tells the person exactly what will happen, in the brand voice, with no hype.
2. **State-honest controls.** 저장하기 stays disabled until something changes. 티켓 쓰기 is disabled and says why. The check draws only after the server confirms (TicketSheet.tsx:99-111, AgentScreen.tsx:152). The last skill can't be switched off (AgentScreen.tsx:217). Logout takes a hold or two taps (AccountScreen.tsx:29).
3. **The agent is the hero.** The blob is the first thing on the tab. The swatches give a 44 px target around a 28 px dot, with named radio labels (agent.css:35-52, AgentScreen.tsx:30, 118-131). This is exactly where the brief wants personality.

## Priority Issues

**[P1] Ticket counts are told apart by colour alone, in two hues outside the palette**
- **What:** The profile shows "3" beside a blue ticket and "0" beside a purple ticket, with no words. The blue is `hsl(214 82% 58%)`, close to but not the accent. The purple is `hsl(286 66% 60%)`, which reads as an agent hue. The sheet repeats both hues inside icon plates.
- **Why it matters:** This fails WCAG 1.4.1 (use of colour) for sighted users. The aria-labels cover screen readers, but the visual has nothing. It also breaks the One Voice Rule and the Agent Owns Its Colour Rule (DESIGN.md): two decorative hues on a screen that should have one accent. Users can't tell which ticket they hold without opening the sheet.
- **Fix:**
  - Replace the two icon-plus-number spans with one trailing detail in the row's own style: `기본 3장 · 프리미엄 0장` in `--label-2`, `--t-body`, tabular-nums.
  - Delete `.profile-ticket__basic` and `.profile-ticket__premium`.
  - In the sheet, drop the row icons (the titles already name the kinds) and give the selected radio `--accent` with a white check, since a selected state is allowed the accent.
- **Evidence:** `29-profile`, `32-tickets-sheet` (all four captures). profile.css:130-139, ProfileScreen.tsx:145-152, TicketSheet.tsx:21-24, 79-81, profile.css:295-299.

**[P2] An icon plate beside every label, in four different sizes**
- **What:** Plates appear in four sizes:
  - every ListRow: 30×30 r8 on `--fill`;
  - every skill row: 32×32 r9;
  - every sheet row: 30×30 r9;
  - the privacy card: a 44 px circle.

  The connections "+" is a 44 px r12 tile, and 학교 급식 even gets a star.
- **Why it matters:** This is the first "Don't" in DESIGN.md ("Don't put an icon in a rounded-square tile next to or above a line of text") and the largest single source of visual noise on the tab. The radii 8, 9 and 11 are also literals that break the Token Radius Rule. Plates repeat what the label already says, so they add scanning cost without adding meaning.
- **Fix:**
  - In `ListRow`, render `icon` in the text flow: `.list-row-plate` becomes 24×24 with no background, the glyph at 20 px in `--label-2`.
  - Keep `iconTint` plates only for third-party service marks.
  - On the profile root keep these in-flow glyphs, because they help scan a 15-row hub.
  - On pushed screens (내 계정, skills), drop the `icon` prop entirely; the titles carry it.
  - Remove `.agent-skill__icon` and `.more-sheet-row__icon`.
  - Turn the privacy card's circle into an in-flow glyph (see the next issue).
- **Evidence:** `30-profile-scrolled`, `31-profile-bottom`, `35-agent-settings-scrolled`, `36-account`, `32-tickets-sheet`. List.tsx:67-71, List.css:88-101, agent.css:142-150, more.css:167-176, profile.css:155-164, 217-228.

**[P2] The hub is a stack of seven differently built boxes**
- **What:** The root mixes the following, which are not one family:
  - the agent card: paper, r24, shadow;
  - the quota card: paper, its title at `--t-title3`;
  - the usage card: paper, its title at `--t-body`, sitting directly under the quota card;
  - the privacy card: paper, a 44 px circle, a two-line bold sentence;
  - the account list: r20, a softer shadow, no visible header;
  - the connections card: paper with an inner tile;
  - two headed list groups.

  In light mode all of them cast shadows. In dark mode the cards get a hairline and the list groups get nothing. Sections are 14 px apart, not 24.
- **Why it matters:**
  - The Flat Paper Rule: paper never casts a shadow.
  - Consistency: the eye has to re-learn each box.
  - "Say it once": the privacy card is an unprompted reassurance sized like a feature, and it pushes the actual settings below the fold.
- **Fix:**
  - Remove the shadow from `.paper` and `.list-card` in light mode (`box-shadow: none`). In dark and increased contrast, give both `inset 0 0 0 1px var(--separator)`.
  - Give profile cards `radius={20}` so they match the list groups (`--r-group`).
  - Set `.profile-quota__title` to `--t-body` 600, like `.paper-header__title`.
  - Use `<Stack gap={24}>` on the profile root.
  - Render the privacy section as a row in the 깽이 group: title `개인 정보 보호`, subtitle `어떻게 암호화하고 보관하는지 알려 드려요`. It opens the same sheet via `presentPrivacy`.
  - Give the account group a visible header, `내 계정`.
- **Evidence:** `29-profile`, `30-profile-scrolled` (dark shows the hairline mismatch most clearly). Card.css:9-17, List.css:26-37, profile.css:62-69 vs Card.css:55-63, ProfileScreen.tsx:71, 193-211, 216.

**[P2] Developer language and the AI glyph on 내 계정 and the agent screen**
- **What:**
  - 내 계정 lists `AI 모델 · deepseek/deepseek-v4.1-flash-ultrafast` beside a bolt, and `모시 이름` beside `sparkles`.
  - The empty-memories note uses `sparkles`.
  - Unconfigured skills get a "키 필요" pill.
  - The usage chart's unit is "토큰" (visible once there is history).
  - Skill blurbs name API products (기상청 초단기실황·단기예보, NEIS, PM10·PM2.5).
- **Why it matters:** PRODUCT.md says the users are not technical and expect the agent to talk like a capable person. DESIGN.md bans `sparkles` as the symbol for the agent. A model id and "토큰" are the two things a Korean consumer is least able to act on.
- **Fix:**
  - On 내 계정, remove the `AI 모델` row and show the id as the 모시 group's footer, in footnote `--label-2`: `지금 쓰는 AI 모델: deepseek-v4.1-flash-ultrafast`.
  - Drop the row icons on that screen, `sparkles` included.
  - Memories empty note: use no icon.
  - `키 필요` becomes `지금은 쓸 수 없어요`.
  - Usage: show each day as a share of the daily limit (the same % unit as the quota card) if the server can provide it. Otherwise drop "토큰" from the visible detail.
  - Ask the server owner to shorten skill blurbs to plain outcomes, for example `기상청 예보로 지금 날씨와 3일 예보를 알려줘요`.
- **Evidence:** `36-account`, `35-agent-settings-scrolled`. AccountScreen.tsx:25-26, AgentScreen.tsx:226, 254, ProfileScreen.tsx:176-185.

**[P2] Agent settings: the name four times, a silent discard, and a heading style that matches nothing else**
- **What:**
  - The first viewport shows "깽이" in the top-bar capsule, the large title, the identity card heading and the name field.
  - The hint "색을 고르면 바로 바뀌어요. 저장해야 남아요." explains a preview-then-save model. Leaving without saving discards the change with no warning.
  - "할 수 있는 일" is a 20 px display heading, while every other section on the tab uses the 13 px list header.
- **Why it matters:**
  - Minimalism: the identity card heading adds nothing the large title doesn't already say.
  - Control: the one screen where edits don't apply at once is also the one with no guard.
  - Consistency: two section-heading systems on one page.
- **Fix:**
  - Delete `.agent-identity__name` and let the hint sit beside the avatar.
  - When the form is dirty, show `저장하지 않고 나가면 바뀐 내용이 사라져요` as a footnote directly above 저장하기, replacing the hint.
  - Render "할 수 있는 일" and "기억하는 것" with the `ListSection` header style (13 px 600 `--label-2`). Keep the count as the header's trailing detail.
- **Evidence:** `34-agent-settings`, `35-agent-settings-scrolled`. AgentScreen.tsx:55, 111-117, 133, 198-205, 245-248, agent.css:106-111.

## Cognitive Load
Checklist failures: 3 of 8 (moderate).
- **Chunking:** the 깽이 group has 6 rows (결제 수단, 저장된 로그인, 정보 공개 범위, 예약된 일, 접근 기록, 친구).
- **Grouping:**
  - 친구 and 정보 공개 범위 sit under "깽이", while 알림 and 화면 sit under "앱 사용", so settings are split across two groups.
  - 접근 기록 is a separate row from 저장된 로그인, though both open the same screen.
- **Minimal choices:** the skills list is 21 toggles on one page.

Decision points with more than 4 visible options:
- the 깽이 group (6);
- "할 수 있는 일" (21; the 생활 category alone has at least 8);
- the hue swatches (7, acceptable for a palette);
- the profile root as a whole (about 15 tappable targets across 7 containers).

## Emotional Journey
- **Peak:** opening the tab on your own blob, then recolouring it on the agent screen. This is the moment of ownership the brand is built on.
- **First valley:** right after the peak comes an empty usage card and then a large shield card announcing "개인 정보를 안전하게 보호하고 있어요". Unprompted reassurance reads as a pitch and invites the question "why are they telling me this?"
- **Second valley:** the ticket sheet when there is nothing to reset. It is a dead end, and its blocking note carries a checkmark, so it looks like success.
- **End:** 내 계정 closes on a calm, reassuring logout note, which is good. The last fact read before it, though, is a raw model id.

## Persona Red Flags
**Jordan (first-timer):**
- Sees "3" by a blue ticket and "0" by a purple one, with no names.
- "한도 초기화 티켓" is only explained inside the sheet.
- "AI 모델 deepseek/deepseek-v4.1-flash-ultrafast" beside a bolt.
- Skill blurbs say NEIS, PM10·PM2.5 and 초단기실황.
- Will not know what "키 필요" asks of them; it asks nothing they can do.

**Sam (screen reader, low vision):**
- The agent card's accessible name reads the whole 106-character persona on every focus (ProfileScreen.tsx:107).
- Disabled 저장하기 and 티켓 쓰기 are a white label on pale blue in light and a grey label on navy in dark, both barely legible.
- Good: swatches are named radios, list rows are real buttons, and pressable cards take Enter and Space.

**Casey (one hand, interrupted):**
- The settings rows (알림 설정, 화면 및 디자인) are two and a half screens down, past the usage and privacy cards.
- The hue swatches sit in the top half of the agent screen.
- An unsaved colour or persona change is lost the moment Casey taps back to check something on the hub.

**Project persona, "지수, the delegator"** (from PRODUCT.md: a non-technical Korean consumer, one-handed, short bursts, expects plain 해요체):
- Model id and "토큰" are noise she can't act on.
- The privacy card tells her something she didn't ask about, at the size of a feature.
- She looks for "what is 깽이 doing / can it do X" and finds a 21-toggle wall whose descriptions name government APIs.

## Minor Observations
- **Ticket sheet:**
  - The blocking note "지금은 초기화할 사용량이 없어요…" uses a `checkmark` icon (TicketSheet.tsx:96). Use no icon and place it directly above the disabled button.
  - The recessed "오늘 사용한 한도" panel (profile.css:243-250, r18 literal) repeats the profile quota card. Make it one plain line over the bar.
- **Connections card:** the "+" tile beside the hint (profile.css:217-228) reads as another icon tile. The whole card is already the button, so drop the tile.
- **Disabled primary buttons:** they keep a blue tint. Disabled could read as `--fill` with a `--label-3` label, so that blue always means "this does something" (One Voice Rule).
- **내 계정:** 아이디 uses an envelope icon (AccountScreen.tsx:21), but the id is not an email. This goes away with the plates.
- **Agent card:** the persona preview truncates mid-phrase ("필요한 걸…"). The first sentence alone would read cleaner.
- **Profile root:** the account group is announced only by `aria-label` (ProfileScreen.tsx:216), while its siblings have visible headers.

## Engine and Theme Differences
- **Dark:**
  - The top-bar avatar sits on a white disc (the `ring` plate, ui/Avatar.tsx:89). It is a bright spot in the dark capsule, invisible in light Chrome and faintly visible in light WebKit. Consider dropping the ring in dark or tinting it `--surface-2`.
  - `.paper` cards get a hairline and `.list-card` groups do not (Card.css:12-14 vs List.css:32-34). This is visible on `30-profile-scrolled` and `31-profile-bottom`.
  - Disabled primaries turn navy with a grey label.
  - The purple ticket is more saturated than in light.
- **WebKit vs Chrome:** identical layout. Hangul line breaks differ slightly in the persona textarea and in the footnotes. Nothing clips. Countdown values differ only by capture time.

## Questions to Consider
- What if the hub were one inset-grouped list from top to bottom: agent row first, quota as a row with its bar, privacy as a row?
- Should a non-technical person ever see a model id, or is that a support-screen fact?
- Every other setting in the app applies at once and rolls back on failure. Why does the agent's colour need a save button?
- The agent's status ("쉬는 중", "마지막으로 일한 때") is the most 모시-specific fact this feature owns. Why is it at the bottom of a pushed screen rather than on the agent card?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 29, 30, 31, 32, 34, 35, 36.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `skipped-heading` | 8 | 29, 30, 31, 32, 34, 35, 36 | <h1> "내 계정" followed by <h3> "계정 정보" (missing h2); <h1> "보관함" followed by <h3> "11월 12일 주간회의 회의록" (missing h2) | **True positive.** `SectionLabel` renders `<h3>` straight after the page `<h1>` (`screens/more/parts.tsx:93`), so VoiceOver's heading rotor skips a level. Make it `h2`. |
| `organic-clip-path` | 7 | 29, 30, 31, 32, 34, 35, 36 | clip-path: path() with 12 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |
| `low-contrast` | 1 | 36 | 4.2:1 (need 4.5:1) — text #d70015 on #f6dfdf | **True positive.** Use `label` on fills (see the snippet). |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** nothing overlaps directly.
- **B caught, A missed:** **[P2]** heading skips on the profile, agent and account screens (`<h1>` → `<h3>`, from `SectionLabel`). **[P2]** the destructive tint button on 내 계정 is 4.2:1 (`#d70015` on `#f6dfdf`). (The save button was disabled in the capture, so the accent-fill contrast issue found elsewhere, 3.6:1, applies here too once it is enabled.)
- **A caught, B missed:** tickets told apart by colour alone (WCAG 1.4.1); icon plates in four sizes; seven differently built boxes with paper shadows; a raw model id and sparkles on 내 계정.
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- **Looked at:** all seven listed screens in chromium-light, chromium-dark and webkit-light, and spot-checked webkit-dark (`29-profile`). Source: ProfileScreen.tsx, TicketSheet.tsx, AccountScreen.tsx, profile.css, AgentScreen.tsx, agent.css, parts.tsx, more.css, ui/Card.{tsx,css}, ui/List.{tsx,css}, plus ui/Avatar, ui/EmptyState.css, ui/Button.css and styles/tokens.css for token checks.
- **Limits:**
  - Stills only, so there are no motion findings; nothing seen contradicts MOTION-SPEC.
  - Fixture data: a fresh account, so no usage history, no saved logins and no memories. The usage chart, the memory list and the restart card were not seen rendered and are judged from source.
  - The agent hue in these captures is pink (random per account). The friends and settings captures use a green agent.
  - The background was not critiqued, per brief.
- **Isolation:** the detector was not run, and no other critique, slop inventory or detect output was read.
- **Method:** impeccable `critique` (Assessment A), `craft-floor`, `ios` and `mode-operate` references. Impeccable is Apache-2.0, © Paul Bakaus. Rule names are quoted only.
