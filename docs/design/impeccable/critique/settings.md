Method: dual-agent (A: critique-a4 · B: impeccable detector over CDP, run by design-director)

# Critique: 설정 (Settings: notifications, privacy and sharing, display, privacy sheet, saved-login vault)

2026-11-12 · Mode: Operate · Screens: `46-settings-notifications`, `47-settings-privacy`, `48-settings-display`, `33-privacy-sheet`, `49-vault`, `50-vault-access-log` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Every "시스템 따름" says what it resolves to right now ("지금은 기기 설정에 맞춰 라이트로 보여요", "지금은 꺼져 있어요"). Toggles apply at once and roll back with a banner. Gaps: the device permission that gates every notification is shown last, and the vault's large title can contradict the selected segment. |
| 2 | Match Between System and Real World | 3 | The privacy sheet's three plain questions are exemplary. Leaks: "화면 위 섬" (a literal Dynamic Island), "시간 맞춤 알림 / 일반 알림" (HIG interruption levels), "보안 금고(Credential Enclave)" in the vault's first line, and a section titled "선택". |
| 3 | User Control and Freedom | 3 | Every toggle is reversible, deletes are two-step, and sheets close by ×, drag or Esc. Gap: the switch that removes the approval step flips with one tap and no undo. |
| 4 | Consistency and Standards | 2 | Three idioms for one kind of screen: inset lists (알림, 정보 공개 범위), stacked paper cards with segmented controls (화면 및 디자인), and a paper preview between list groups. Dark gives cards a hairline and lists none. Row titles are "정보 공개 범위 설정" in one place and "정보 공개 범위" in others. |
| 5 | Error Prevention | 2 | Good: 브리핑 시간 is disabled while 브리핑 is off, and vault deletes are two-step. Gaps: "다른 사람에게 보내기 전에 묻기" turns off in one tap, and notification toggles read "on" while the device has never been asked. |
| 6 | Recognition Rather Than Recall | 3 | Current values are visible everywhere, and the live "친구의 모시는 이렇게 봐요" preview shows the effect of each switch with a real-looking value. |
| 7 | Flexibility and Efficiency of Use | 2 | System defaults everywhere and −/+ steps on the text slider. No "pause all notifications" control. Each saved login's retention is a 5-way segmented control per card. |
| 8 | Aesthetic and Minimalist Design | 2 | A plate beside every row (`sparkles` for memory included), plated preview lines, 64 px glyph circles on the empty states, and the "we can't see it" reassurance said five times across the feature. |
| 9 | Help Users Recognize, Diagnose, and Recover from Errors | 3 | A failed save is said once from the island in Korean, and the control springs back (useSetting.ts:13-17). A denied permission gets a recovery footer ("브라우저 설정에서 이 사이트의 알림을 허용하면…"). |
| 10 | Help and Documentation | 3 | The privacy sheet is real contextual help, and the cryptography sits behind "자세히 보기" with a verifiable measurement. Each group's footer states the consequence. |
| | **Total** | **26/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** Mixed, with a few genuinely authored moments.
- **Authored:**
  - The privacy screen's live preview of what a friend's agent sees, using sample values ("오후 3:00 · 팀 회의", "강남구 근처").
  - The text-size preview, where your own agent speaks at the size you pick and uses its name.
  - The privacy sheet's verifiable enclave measurement.
  - The access log's "이 기기의 키로 확인했어요".

  Only 모시 could have these, and they serve Principles 2 and 3 directly.
- **Generic:** plated settings rows, centred empty states with a glyph in a grey circle, and a display page built from stacked cards. Any app could ship those.

Two things undercut the product's own principles. The safety switch that makes "Nothing leaves without consent" true is the least findable control in the feature. And "The phone keeps the secrets" is repeated until it reads like marketing.

**Deterministic scan.** See Assessment B below.

## Overall Impression
The settings feel trustworthy in their details: honest system defaults, optimistic toggles that roll back, and a privacy explainer that leads with plain questions and hides the cryptography one tap down. The two serious problems are about order, not looks. The approval switch is buried and unguarded, and the notification permission comes after the toggles it controls. Fix those two and strip the plates and repeated reassurances, and this becomes the calmest part of the app.

## What's Working
1. **"시스템 따름" that tells you what it means right now.** "지금은 기기 설정에 맞춰 라이트로 보여요." and "지금은 꺼져 있어요" sit beside each override (DisplayScreen.tsx:53, 90, 97). This is MOTION-SPEC §8.15 done properly: a default is only useful if you can see what it resolved to.
2. **Progressive disclosure in the privacy sheet.** Three questions a person would actually ask ("무엇을 보관하나요 / 누가 볼 수 있나요 / 어떻게 지우나요") come first. The seal flow, ECDH and the SHA-256 measurement wait behind "암호화가 어떻게 되는지 자세히 보기" (PrivacySheet.tsx:43-111).
3. **Optimistic settings with honest rollback.** Every toggle applies at once. A failure rolls the control back and says why, once, from the island (useSetting.ts:13-17, store `updateSettings`). Dependent controls disable instead of disappearing: 브리핑 시간 follows 브리핑 (NotificationsScreen.tsx:37, 44).

## Priority Issues

**[P1] The switch that removes the approval step is buried and flips off with one tap**
- **What:** "다른 사람에게 보내기 전에 묻기" is the last group on a screen titled 정보 공개 범위 설정. Its row label on 나의 모시 says nothing about sending. It turns off with a single tap: no confirmation and no undo.
- **Why it matters:** Product Principle 2, "Nothing leaves without consent", depends on this switch. A person scrolling past three sharing toggles can flip it without noticing. A person who wants to check that it is on won't think to look under "information disclosure".
- **Fix:**
  - Move the "보내기 전에" group to the top of PrivacyScreen, above "친구의 모시에게". Keep its footer.
  - On switching it off, drop the 5-second undo banner from the island (MOTION-SPEC §8.6 low tier, §8.13): `보내기 전 확인을 껐어요` with a `되돌리기` action.
  - While it is off, show a detail on the 나의 모시 row that opens this screen: `보내기 전 확인 꺼짐` in `--label-2`. Add a case to `detail()` in ProfileScreen.tsx:280-296.
- **Evidence:** `47-settings-privacy` (the group is below the fold in all four captures). PrivacyScreen.tsx:70-77; ProfileScreen.tsx:37, 280-296.

**[P1] Notification toggles read "on" while the device has never been asked**
- **What:** The first thing on 알림 설정 is three blue toggles. The permission that decides whether any of them arrive when the app is closed is the last section, below the fold, labelled "이 기기", with a small neutral 허용하기.
- **Why it matters:** The screen shows a working state that isn't true. The person leaves believing the briefing will come at 07:30, and it doesn't. That becomes "알림이 안 와요", which is a support message.
- **Fix:**
  - Render `<DevicePermission />` first (move NotificationsScreen.tsx:75 above line 27).
  - While permission is `default`, make 허용하기 the screen's one primary: `tone="primary"`. The toggles are on-states, so this is still one accent.
  - While permission is not `granted`, give the first group the footer `기기 알림을 허용해야 앱을 닫았을 때도 받아요.`.
  - Keep the denied-state footer as it is.
- **Evidence:** `46-settings-notifications` (all four captures). NotificationsScreen.tsx:27-75, 89-121.

**[P2] "We can't see your passwords" is said five times across one feature**
- **What:** The reassurance appears:
  1. in the vault note: "깽이도, 서버 운영자도 원문을 볼 수 없어요";
  2. in the vault's empty body: "여기에 안전하게 보관돼요";
  3. in two privacy-sheet lines: "암호화된 채로만", "원문을 보지 못하고";
  4. in the privacy preview's fourth line: "로그인 정보 · 절대 볼 수 없어요";
  5. on the 나의 모시 card that opens the sheet: "개인 정보를 안전하게 보호하고 있어요".
- **Why it matters:** Product Principle 3 says "plainly, once, where it matters", and DESIGN.md says "Say it once". Repetition makes a true statement sound like a pitch, and it pushes the controls down.
- **Fix:**
  - Keep the privacy sheet as the explainer.
  - Keep one vault line, shown only when there are saved logins, rewritten in plain Korean: `비밀번호는 이 기기에서 암호화한 뒤 보안 금고에만 보관해요. 깽이도, 운영자도 원문을 볼 수 없어요.`
  - Empty body becomes `메신저를 연결하거나 깽이가 로그인이 필요할 때 입력한 정보가 여기에 보관돼요.`
  - Move the preview's 로그인 정보 line into the "친구의 모시에게" group footer: `로그인 정보는 어떤 경우에도 친구의 모시에게 보이지 않아요.`
  - The 나의 모시 card becomes a row (see the 나의 모시 critique).
- **Evidence:** `49-vault`, `33-privacy-sheet`, `47-settings-privacy`. VaultScreen.tsx:84, 93; PrivacySheet.tsx:44-45; PrivacyScreen.tsx:57; ProfileScreen.tsx:193-211.

**[P2] Plates beside every row, `sparkles` for memory, and grey circles on empty states**
- **What:** The plates and glyph tiles are:
  - every ListRow on 알림 and 정보 공개 범위: 30×30 r8;
  - the preview lines: 28×28 r8;
  - the privacy sheet lines: 34×34 r10;
  - both vault empty states: a 64 px glyph circle.

  The memory row uses `sparkles`.
- **Why it matters:**
  - DESIGN.md "Icon tiles go", with the empty-state glyph named explicitly.
  - "No AI-cliché glyphs".
  - The Token Radius Rule (8 and 10 are literals).
  - On pushed settings screens, every title already says what the icon says.
- **Fix:**
  - Remove the `icon` prop from the rows on NotificationsScreen and PrivacyScreen. On these pushed screens the titles carry it.
  - Delete `.privacy-preview__icon` and `.privacy-line__icon`. The question headings carry the sheet.
  - In EmptyState, render the glyph at 32 px in `--label-3` with no circle: `.empty-state__plate { width:auto; height:auto; background:none }`.
  - Use no glyph at all for 기억하기.
- **Evidence:** `46-settings-notifications`, `47-settings-privacy`, `33-privacy-sheet`, `49-vault`, `50-vault-access-log`. List.tsx:67-71; List.css:88-98; PrivacyScreen.tsx:62; settings.css:102-111; profile.css:312-320; ui/EmptyState.css:10-19.

**[P2] Platform jargon and a state-sounding subtitle on 알림 설정**
- **What:**
  - The footer reads "앱을 쓰는 동안에는 화면 위 섬에서 알림이 내려와요.", a literal Dynamic Island.
  - Every subtitle ends with "· 시간 맞춤 알림" or "· 일반 알림" (HIG interruption levels).
  - A section is titled "선택".
  - "혜택·소식" is switched off, yet its subtitle "조용히 목록에만 쌓여요" reads as its current behaviour.
  - The vault's first line explains itself with "(Credential Enclave)".
- **Why it matters:** The users are non-technical Korean consumers (PRODUCT.md). "섬" and "시간 맞춤 알림" make them translate, and an "off" toggle with an "on" description is a small contradiction.
- **Fix:**
  - Footer: `앱을 쓰는 동안에는 화면 맨 위에서 알림이 잠깐 내려와요.`
  - Drop the "· 시간 맞춤 알림 / · 일반 알림" suffixes.
  - Section title: `선택 동의`.
  - 혜택·소식 subtitle: `켜면 알림 없이 목록에만 쌓여요`.
  - Remove "(Credential Enclave)" from the vault line. The sheet's "자세히" keeps the English term for those who want it.
- **Evidence:** `46-settings-notifications`, `49-vault`. NotificationsScreen.tsx:27, 31, 55, 61, 66-70; VaultScreen.tsx:84.

## Cognitive Load
Checklist failures: 2 of 8 (moderate).
- **Grouping:**
  - Send approval and agent memory live on a screen named 정보 공개 범위.
  - The device permission sits apart from the toggles it gates.
- **Visual hierarchy:** on 알림 설정, the control that decides whether anything works comes last and is the least emphasised.

Decision points with more than 4 visible options:
- Each saved login's 보관 기간 is a 5-option segmented control (1시간 · 1일 · 7일 · 30일 · 계속) inside its card. This was judged from source only (VaultScreen.tsx:197-205); the fixture account had no saved logins.
- 화면 및 디자인 shows three 3-option segmented controls plus a slider. Each stays within 4, but it is a lot of chrome for "follow the system".

## Emotional Journey
- **Stakes:** this feature holds the app's highest-trust moments: what friends' agents see, where passwords live, and whether anything is sent without asking.
- **Peak:** the privacy sheet. It is calm and specific, and it is verifiable.
- **Valley:** the empty vault. A grey key circle, an English term in parentheses, and a third "safely stored" sentence feel defensive rather than reassuring.
- **Delayed valley:** 알림 설정 looks finished, with blue toggles and 07:30, and the disappointment arrives tomorrow morning when no briefing does.
- **End:** 화면 및 디자인 ends warmly. Your own agent answers at the size you choose.

## Persona Red Flags
**Jordan (first-timer):**
- Reads "시간 맞춤 알림" and "화면 위 섬" and doesn't know what either means.
- Sees "선택" as a section title with no object.
- Meets "보안 금고(Credential Enclave)" as the first sentence of the vault.
- Toggles 혜택·소식 off and reads "조용히 목록에만 쌓여요" as if it were still on.

**Sam (screen reader, low vision):**
- Good: every toggle is labelled, the segmented controls are radiogroups, and the time input has a label.
- The privacy preview changes value through ContentSwap, but the section is not a live region, so the effect of a toggle is not announced (PrivacyScreen.tsx:50-58).
- Increased contrast has no in-app override next to motion and transparency. It follows the system only.

**Casey (one hand, interrupted):**
- The permission row and its small 허용하기 are at the bottom of a scrolled page.
- The briefing time input is 36 px tall (settings.css:12), under the 44 px floor.
- On the vault, 보기 re-hides after 10 s, which is correct for security, but Casey loses it whenever a banner pulls focus.

**Project persona, "은정, the cautious approver"** (from PRODUCT.md Operating Context: approving calls, messages and payments, and typing a messenger password):
- She wants to confirm that nothing is sent without her OK, and can't find that setting from its row name.
- Once found, it turns off with the same single tap as "대략적인 위치", and there is no way back if that happens by accident mid-scroll.

## Minor Observations
- **화면 및 디자인:**
  - The text-size preview and its slider are two separate papers for one control (DisplayScreen.tsx:58-80). Put the slider at the bottom of the preview paper, above a hairline.
  - In the preview, the agent's reply is a grey bubble, while chat renders the agent's text on paper without a bubble (settings.css:48-54 vs `05-chat-welcome`). Render it the way chat does. The user bubble uses `--fill-2` instead of the `bubble-me` token.
  - The page uses a third idiom (SectionLabel + Note + paper cards) where 알림 and 정보 공개 범위 use ListSection. The overrides could be two ListRows, each with a trailing value (`시스템 따름 ›`) and the 3-way segmented control kept inside.
- **Vault:**
  - The large title is fixed by the entry row while the segmented control switches content (VaultScreen.tsx:78-80). Enter from 접근 기록, switch to 로그인 정보, and the title still says 접근 기록. Let the title follow the segment with a content swap.
  - The access-log empty state offers no action, although MOTION-SPEC §8.14 asks for one. A `로그인 정보 보기` that switches the segment would do.
  - The credential card's provider Plate uses `radius={11}` (VaultScreen.tsx:171). Hue plates are allowed for third-party marks, but the radius should be `--r-tile` (12).
- **Time input:** the briefing time input is r10 and 36 px tall (settings.css:11-21). Use `--r-field` and `min-height: 44px`.
- **Privacy sheet:** the closing pair of neutral buttons (저장된 로그인, 접근 기록; PrivacySheet.tsx:113-120) duplicates two rows on 나의 모시. They are fine as shortcuts, but they are the sheet's only actions and they compete with the disclosure row above them.
- **Naming:** the screen is named "정보 공개 범위 설정" from 나의 모시 and "정보 공개 범위" from the invite sheet and the route table (ProfileScreen.tsx:37; InviteSheet.tsx:95). Pick one.

## Engine and Theme Differences
- **WebKit vs Chrome:** WebKit renders the briefing time without the clock glyph and with spaced digits ("07 : 30"). Chrome shows a clock indicator inside the field. This is native control divergence from `type="time"` (settings.css:11-21). Style it as a plain text value in both, or hide `::-webkit-calendar-picker-indicator` in Chrome.
- **Dark:**
  - The paper cards (privacy preview, text preview, slider, overrides) get a hairline and the list groups don't. This is most visible on `47-settings-privacy` and `48-settings-display`.
  - The segmented thumb is grey in dark and white in light. Both read correctly.
  - The off-toggle tracks stay legible.
- **WebKit line breaks:** the vault empty body and the access-log body wrap at a shorter measure. Nothing clips.

## Questions to Consider
- Should "보내기 전에 묻기" be switchable from a screen people reach by tapping "정보 공개 범위", or does it deserve its own row on 나의 모시?
- What if 알림 설정 opened on the device state, with the kind toggles disabled until notifications are allowed?
- Does an empty vault need to promise anything at all, or is "아직 저장된 로그인이 없어요" plus one action enough?
- The privacy preview shows the effect of each toggle. Could it replace the row subtitles instead of repeating them?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 46, 47, 48, 33, 49, 50.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `skipped-heading` | 9 | 33, 46, 47, 48, 49, 50 | <h1> "보관함" followed by <h3> "11월 12일 주간회의 회의록" (missing h2); <h1> "알림 설정" followed by <h3> "모시가 보내는 알림" (missing h2); <h1> "정보 공개 범위 설정" followed by <h3> "친구의 모시에게" (missing h2) | **True positive.** `SectionLabel` renders `<h3>` straight after the page `<h1>` (`screens/more/parts.tsx:93`), so VoiceOver's heading rotor skips a level. Make it `h2`. |
| `organic-clip-path` | 6 | 33, 46, 47, 48, 49, 50 | clip-path: path() with 12 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |
| `low-contrast` | 1 | 49 | 3.6:1 (need 4.5:1) — text #ffffff on #0a84ff | **True positive.** Every primary button fails: white on `#0A84FF` is 3.6:1 against the 4.5:1 needed at 17 px semibold. Fix it at token level: the button fill becomes the existing `--accent-text` `#0071E3`, which gives 4.7:1 (slop-inventory §2). |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** nothing overlaps directly.
- **B caught, A missed:** **[P2]** heading skips on all three settings screens and in the vault (`<h1>` → `<h3>`). **[P1]** white on accent on the vault's 카카오톡 연결하기 (3.6:1).
- **A caught, B missed:** 보내기 전에 묻기 turns off in one tap with no undo; notification toggles that show on while device permission is still unasked; the reassurance said five times; plates, sparkles and jargon.
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- **Looked at:** all six listed screens in chromium-light, chromium-dark and webkit-light, and spot-checked webkit-dark (`48-settings-display`). `05-chat-welcome` (chromium-light) was opened once, only to compare how chat renders the agent's text against the text-size preview.
- **Source:** NotificationsScreen.tsx, PrivacyScreen.tsx, DisplayScreen.tsx, useSetting.ts, settings.css, PrivacySheet.tsx (with profile.css:301-432), VaultScreen.tsx, vault.css, ui/List.{tsx,css}, ui/EmptyState.css, ui/SegmentedControl.css, ui/Button.css, and api/store.ts `updateSettings`.
- **Limits:**
  - Stills only, so there are no motion findings. The vault's hide-on-visibility behaviour and the privacy preview's content swap were read in source, not seen.
  - Fixture data: a fresh account with no saved logins and no access records, so the credential card and the access-log timeline were judged from source only.
  - Below the fold and not captured: 화면 및 디자인's transparency override, most of 정보 공개 범위's memory group and all of its "보내기 전에" group, and 알림 설정's permission footer.
  - The background was not critiqued.
- **Isolation:** the detector was not run, and no other critique, slop inventory or detector output was read.
- **Method:** impeccable `critique` (Assessment A), `craft-floor`, `ios` and `mode-operate` references. Impeccable is Apache-2.0, © Paul Bakaus. Rule names are quoted only.
