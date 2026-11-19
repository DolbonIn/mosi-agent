Method: dual-agent (A: critique-a1 · B: impeccable detector over CDP, run by design-director)

# Critique: 채팅 (Chat: thread, streaming, composer, cards)

2026-11-12 · Mode: Operate · Screens: `08-chat-cards-latest-phone-approval`, `09-chat-weather-card`, `10-chat-results-card`, `11-chat-messenger-card`, `12-chat-credential-card`, `13-chat-meet-approved`, `14-chat-meeting-events`, `15-chat-meeting-summary-artifact`, `16-chat-schedule-card`, `17-composer-focused-typed` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Tool steps fold into "N단계 · N초" and expand to sources, and receipts are honest. Gaps: "93초" is never written as "1분 33초", and the jump capsule says "최신 메시지" even when nothing is new. |
| 2 | Match Between System and Real World | 3 | Plain 해요체 throughout. The credential card says "모시도 볼 수 없어요" while the agent in the same thread is 깽이 ("저도 볼 수 없어요"). A Meet join is framed as "보낼 내용". |
| 3 | User Control and Freedom | 3 | 취소 on every approval, Stop while streaming, a 5 s undo for schedules, 다시 보내기 on failed bubbles. |
| 4 | Consistency and Standards | 2 | Five icon-plate sizes (32/36/40/44/56 px) and three radii (10/12/18). Two blue controls on the call approval. Sources appear as a pill ("정부24") on one card and as a footnote ("출처 · 기상청") on the next. Chat markdown takes its spacing from the archive stylesheet. |
| 5 | Error Prevention | 3 | The high-risk confirm needs a 1.2 s hold or two taps, and it quotes the exact words with the number masked. The credential card only validates on submit, and its error appears under the button, not under the field. |
| 6 | Recognition Rather Than Recall | 3 | Results stay inline as cards, so nothing has to be remembered between turns. |
| 7 | Flexibility and Efficiency of Use | 3 | Enter / Shift+Enter, dictation, attachments, quick replies and steering while a turn runs. No accelerators past that, which is fine for this category. |
| 8 | Aesthetic and Minimalist Design | 2 | Six glass shapes on one screen. Card-in-card on weather, messenger and approval. An icon plate heads every card. Kicker labels. A red badge. Paper still casts shadows in light mode. |
| 9 | Error Recovery | 3 | Failed bubbles get "보내지 못했어요 · 다시 보내기". Approval and credential errors are inline with `role="alert"`, and tool chips have an error state. The credential error sits away from the field it names. |
| 10 | Help and Documentation | 2 | Tool steps show their sources, which helps. The hold/two-tap rule exists only in `aria-describedby`, and there is no other contextual help. |
| | **Total** | **27/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** In function, the thread is authored for this product. Tool calls fold into one quiet step line. The call approval quotes the exact sentence the agent will say, masks the number, and asks for a hold. A schedule is simply done and offered back with an undo. Receipts say "이 기기의 키로 확인했어요". Few chat apps get these details right.

The visual layer is category-interchangeable. Every card uses the same scaffold: a 32–44 px grey rounded plate, then a 600-weight title, then an optional grey or red pill, then a recessed grey panel. With the copy covered, weather, results, messenger, approval, credential, schedule and artifact are one template in seven colours of content. That is the generated-assistant look the user wants removed.

The product's own signature barely enters the thread. The agent's avatar dot, its hue and the island appear only in the chrome. The sources (기상청, 정부24, 슬랙) are the most product-specific facts on these cards, yet they get the weakest treatment: a grey pill or a footnote.

**Deterministic scan.** See Assessment B.

## Overall Impression
The structure is right and the consent moments are strong. The surface is over-built: too many glass shapes, an icon plate on every card, grey panels nested inside white cards, and three colour signals on the one card that needs a decision. The biggest opportunity is subtraction. Flatten every card to one paper layer with rows and hairlines, and cut the chrome to the glass the screen actually needs. The thread would then read as the calm record that PRODUCT.md promises ("Done, then shown").

## What's Working
- **Tool activity is quiet and true.** Live chips fold into one "1단계 · 3초 ⌄" line once the turn ends, and expanding it shows each step's title, summary and source (`ToolChips.tsx:42-85`). Status is visible without decorating the thread. This is the right density for a messaging app.
- **The high-risk approval is a real consent surface.** "02-***-1234로 전화해서 이렇게 전할게요: “안녕하세요, 하늘 님 대신…”" shows exactly what will be said. "전화 걸기" is a `ConfirmButton` that takes a 1.2 s hold or two taps in the same place (`ApprovalCard.tsx:108-113`). The receipt only flips after the server accepts (`ApprovalCard.tsx:105-129`). This is Principle 2 ("Nothing leaves without consent") done properly.
- **Neutral user bubbles and one accent.** User bubbles are an 8 % ink tint with no blue (`chat.css:8`, `chat.css:147-151`). The composer's send arrow is the only blue until there is text (`17-composer-focused-typed`). The schedule card follows "do it, then offer undo" instead of asking first (`Messages.tsx:190-208`).

## Priority Issues

**[P1] Six glass shapes on the chat screen, and the jump capsule floats over content whenever you scroll up**
- **What:** The steady state shows menu circle, name capsule and 초대 capsule (`TopBar.tsx:31-63`, `ChatScreens.tsx:25`), plus the composer (`Composer.tsx:209`) and the tab bar (`TabBar.tsx:165`). That is five. "최신 메시지" makes six. It appears whenever the list is more than 640 px from the end, even when nothing is new (`ThreadView.tsx:128`, `ThreadView.tsx:324-330`). In 6 of the 10 chat shots it sits over message text or a tool line (`09` covers the "1단계 · 3초" chevron, `11` covers the KakaoTalk reply). In WebKit (`webkit-light-10/11/13`) its tint is nearly transparent and the label collides with the sentence beneath it.
- **Why it matters:** DESIGN's Two-Layer Rule allows ≤3 glass shapes. Past that, the glass stops reading as function and starts reading as decoration. A one-handed reader also loses the line they were reading under a capsule that has nothing new to say.
- **Fix:**
  1. Drop the 초대 capsule from the chat root (`ChatScreens.tsx:25`). Invite stays in the drawer's 친구 and in the agent sheet.
  2. Show the jump control only when there is real news: remove `far` from `ThreadView.tsx:324` and keep `newBelow` ("새 메시지").
  3. Make that control non-glass: an opaque `--surface` capsule with the hairline `inset 0 0 0 1px var(--separator)`, 44 px, label colour `--label`.
  4. That leaves four shapes. To reach three, render the centre as plain avatar + name (no capsule) over the existing scroll-edge mask, the way iOS 26 sets a nav title. The 44 px row stays the tap target for the agent sheet.
- **Evidence:** `chromium-light-09/10/11/12/13/14`, `webkit-light-10/11/13` (transparent capsule). `ThreadView.tsx:128`, `ThreadView.tsx:324-330`, `TopBar.tsx:31-63`, `ChatScreens.tsx:25`, `chat.css:603-620`.

**[P1] Every card wears the same generated scaffold: icon plate, nested grey panel, kicker, paper shadow**
- **What:**
  - *Icon plates.* Every card head has a rounded grey plate, in five sizes and three radii: briefing 32/r10 (`cards.css:87-96`), weather 56/r18 (`cards.css:115-124`), results 36/r10 (`cards.css:206-216`), messenger 32/r10 (`cards.css:256-264`), schedule 40/r12 (`cards.css:300-309`), approval and credential 36/r12 (`cards.css:332-341`, `427-436`), artifact 44/r12 (`cards.css:504-513`).
  - *Card in card.* The weather hourly forecast is a row of five grey tiles inside the white card (`cards.css:160-170`), and it stops 26 px short of the card's content edge (`09`). The messenger excerpt is a grey panel inside the card (`cards.css:265-273`). The approval preview is a grey panel with a "보낼 내용" kicker (`cards.css:352-364`).
  - *Kickers.* The artifact card puts a "문서" kicker above its title (`ArtifactCard.tsx:31`).
  - *Shadows.* Light-mode paper still casts the two-layer shadow (`cards.css:13`, `ui/Card.css:9`).
- **Why it matters:** These are exactly the residues DESIGN's Direction names ("Icon tiles go", "No card inside a card", "Paper is flat", "No kicker labels"). impeccable's craft floor flags nested cards as always wrong, and an eyebrow over a heading as a ban. Together they make seven different records look like one template, and they spend vertical space on a 390 px screen.
- **Fix:**
  - Delete the plate wrappers (`.brief-icon`, `.res-icon`, `.mc-provider`, `.sched-icon`, `.appr-icon`, `.cred-lock`, `.art-plate`). Where a glyph adds type information (approval: phone, artifact: doc), set it inline at 17 px in `--label-2` before the title. Otherwise drop it.
  - Weather: the 40 px condition glyph sits bare beside "9°". The hourly forecast becomes five plain columns, with no fill, `justify-content: space-between` across the card, and a 0.5 px `--separator` hairline above.
  - Messenger: rows sit directly on the card with hairlines between them.
  - Approval preview: plain body text, no panel, no kicker.
  - Artifact: title plus meta, no "문서".
  - Shadows: set `box-shadow: none` on `.ccard` and `.paper` in light mode. `#fff` on `--bg` carries the edge, and dark already uses the hairline.
- **Evidence:** `09`, `10`, `11`, `12`, `13`, `15`, `16` in all engines and themes. The file:line references above.

**[P1] The call approval sends three colour signals at the decision moment, and the approval vocabulary assumes "send"**
- **What:**
  - *Colour.* The pending high-risk card shows a red "확인 필요" badge (`ApprovalCard.tsx:86`, `cards.css:342-345`), the blue "전화 걸기" primary, and a blue "취소". `Button` plain + secondary resolves to `--accent-text` (`ApprovalCard.tsx:111`, `Button.css:121-124`).
  - *Vocabulary.* Every approval that is not phone, payment or delete falls to the "medium" tier (`util.ts:62-70`). That tier gets a paper-plane glyph (`ApprovalCard.tsx:66`), a "보낼 내용" panel (`ApprovalCard.tsx:91`) and a "보내기" button (`ApprovalCard.tsx:121`). The Meet join card (`13`) is "Google Meet 회의에 참여할까요?" under a paper plane and a "보낼 내용" label, and while pending its button would read "보내기".
- **Why it matters:** The One Voice Rule allows one blue control per screen. Red is reserved for errors and destructive confirms, and a pending call is neither. Three signals compete with the one action the person must judge. A verb that doesn't match the action, at the moment of consent, undercuts Principle 2.
- **Fix:**
  - Remove the "확인 필요" badge: the title's question and the button already ask.
  - Set 취소 to `tone="neutral"` plain (`--label`).
  - Derive glyph and verb from the tool, not the risk tier. Use the tool's declared icon (the server already declares `icon: "people"` for `sys_join_meet`) at 17 px inline. Button verbs: `sys_join_meet` → "참여하기", messages → "보내기", everything else → "승인하기".
  - Show the preview panel only for content that will actually be sent.
- **Evidence:** `08`, `13`, `16`, `17`, `19` (light, dark, WebKit). `ApprovalCard.tsx:66`, `86`, `91`, `111`, `121`. `util.ts:62-70`. `Button.css:121-124`.

**[P2] Chat text is styled by the archive's stylesheet, and the assistant loses its speaker corner**
- **What:** `archive.css` declares global `.md { line-height: 1.6 }` and `.md > * + * { margin-top: 0.75em }` (`screens/more/archive/archive.css:466-475`). These override the thread's own `.md` rules (1.55 and 4 px, `chat.css:327-338`). The measured line pitch in `05` is 27.5 px (that is 1.6, not 1.55). Every block in `15`, bullets included, sits about 40 px apart, so 정한 것 / 할 일 / 다음 회의 have as much space below them as above and don't group. Separately, `.paper`'s `border-radius` shorthand (`ui/Card.css:7`) wins over `.asst-text { border-top-left-radius: 8px }` (`chat.css:283-287`). User bubbles keep their 8 px tail and assistant bubbles are fully round (verified on a crop of `09`).
- **Why it matters:** How the thread looks depends on which screen's CSS loaded last. That is a consistency bug, and it is invisible in code review. DESIGN specifies "20 px with an 8 px tail corner on the speaker's side".
- **Fix:**
  - Scope the archive rules to `.arc-doc .md` (or rename them `.arc-md`).
  - Raise the tail's specificity: `.paper.asst-text { border-top-left-radius: 8px }`.
  - In `markdown.tsx:158`, render a line that is only `**…**` as `md-h3` with 12 px above and 4 px below.
- **Evidence:** `05`, `15` (all engines). `archive.css:466-475`. `chat.css:283-287`, `chat.css:327-338`. `ui/Card.css:7`.

**[P2] The credential card repeats the reassurance and names the brand instead of the agent**
- **What:**
  - *Repetition.* The same promise appears in the seeded welcome ("…휴대폰에서 암호화되어 저도 볼 수 없으니 안심하세요.", `apps/server/src/auth.ts:150`), in the reply above the card ("비밀번호는 이 기기에서 암호화돼서 저도 볼 수 없어요."), and in the card footnote ("기기에서 암호화돼요 · 모시도 볼 수 없어요", `CredentialCard.tsx:130-133`).
  - *Locks.* There are two lock glyphs, one in a plate in the head (`CredentialCard.tsx:93-95`) and one in the footnote.
  - *Wording.* "휴대폰에서", "기기에서" and "이 기기에서" are used interchangeably, and "모시도" contradicts the agent's own "저도".
  - *Error placement.* A missing field produces its error under the save button (`CredentialCard.tsx:153-157`), although `TextField` supports `error` and `hint` (`ui/TextField.tsx:18-19`).
- **Why it matters:** DESIGN: "Say it once… it stays only beside the password field". PRODUCT Principle 3: "the UI says so plainly, once, where it matters". Repetition makes a security promise sound like marketing, and calling the agent "모시" here blurs who is holding the secret.
- **Fix:**
  - Pass the sentence as the password field's `hint`: "이 기기에서 암호화돼요. 깽이도 볼 수 없어요." (agent name via `josa`, never the brand).
  - Delete the footnote row and the head lock plate.
  - Pass missing-field errors to that field's `error`.
  - Drop the sentence from the welcome (see `empty-thread.md`).
- **Evidence:** `12` (all engines), `05`. `CredentialCard.tsx:93-95`, `130-133`, `153-157`. `auth.ts:150`.

## Cognitive Load
Checklist failures (3, moderate):
- **Single focus:** fails. Up to six glass shapes plus the jump capsule compete with the reading line, and the approval card shows three colour signals.
- **Visual hierarchy:** fails. Every card head has the same plate + 600 title + pill weight, so the one card that needs a decision (approval, credential) is set like the read-only ones until you reach its button.
- **Minimal choices:** borderline. "보관 기간" on the credential card offers five segments (1시간 / 1일 / 7일 / 30일 / 계속). The 7일 default rescues it, but it is a decision point with more than four options at the most sensitive moment. Consider moving the choice behind "7일 동안 보관해요 · 바꾸기".

Passing: chunking (cards group well), grouping, one thing at a time, working memory, progressive disclosure (the tool step pill is a good example).

Decision points with >4 visible options: credential keep-for (5).

## Emotional Journey
- **Ask (bubble):** immediate and calm. The neutral bubble renders in the same frame.
- **Wait (tool chips, island):** reassuring. The status names the real tool and later folds away.
- **Result (cards):** competent but samey. Weather, results and messenger all arrive in the same plated, nested template, so the moment of "it's done" has no texture of its own.
- **High stakes (call approval, credential):** the content is excellent (exact words, masked number, hold to confirm). The surface undermines it: a red badge reads as an error, a blue 취소 competes with 전화 걸기, and the reassurance is said three times, which sounds less sure, not more.
- **End (receipt):** "승인했어요 · 오전 7:08" plus "이 기기의 키로 확인했어요" is a good peak-end close when the access log verifies. In the fixture, `13` shows only "승인했어요", so the closing proof is missing there.

## Persona Red Flags
**Casey (Distracted Mobile User):** Reading history one-handed, Casey scrolls up 640 px and the "최신 메시지" capsule lands on the line being read (`09`, `11`). It never leaves until Casey scrolls back down. The credential card asks Casey to type a password and also pick from five keep-for options before the only button.

**Sam (Accessibility-Dependent User):** On the high-risk card, the hold-or-two-tap instruction lives only in `aria-describedby`. Sighted keyboard users get no visible hint until the first press changes the label. The red "확인 필요" badge carries meaning by colour plus a word, which passes, but it is announced before the title's question. Event notes in light mode are `--label-2` on `--fill` over `--bg`, about 4.1:1 by token math, below 4.5:1 for 13 px text (`chat.css:211-220`).

**Jordan (Confused First-Timer):** The phone glyph in the composer means "talk to 깽이" (`Composer.tsx:267`). On the card above it, the same phone glyph means "깽이 calls the dentist" (`ApprovalCard.tsx:66`). Jordan reads the composer's phone as "call the business". On the credential card, "모시도 볼 수 없어요" introduces a third name in a thread where Jordan has only met 깽이.

**Project persona: The one-sentence delegator, "지은"**
- *Profile (from PRODUCT.md Users):* non-technical; hands chores to the agent she named; uses the phone one-handed in short bursts; expects a capable person, not software.
- *Behaviors:* sends one sentence ("연세바른치과에 내일 3시 예약 되는지 전화해서 물어봐 줘"), glances at the result, leaves.
- *Red flags:* the result cards look like a dashboard kit instead of a person's report; "2단계 · 93초" reads like a log; a red "확인 필요" pill makes a routine call feel like a warning.

## Minor Observations
- `stepsSummary` prints raw seconds ("93초") while `durationKo` already formats "1분 33초" (`app/agentVocab.ts:102-105` vs `util.ts:42-48`).
- Sources use two patterns: a header pill ("정부24", `InfoCards.tsx:120`) and a footnote ("출처 · 기상청", `InfoCards.tsx:108`). Pick the footnote everywhere.
- Badges mean three different things in the same slot: source ("정부24"), past action ("읽음"), warning ("확인 필요").
- Results dividers run 16 px wider than the text column (`.res-list { margin: -4px -8px }`, `cards.css:188`). Briefing dividers are inset to the text, so adjacent cards disagree.
- The assistant paper uses r22 (`chat.css:284`) directly above r24 cards. Two near-identical radii stacked read as a mistake. Use `--r-card`.
- An unknown icon name renders an empty SVG silently (`ui/Icon.tsx:413`). The fixture's `moon` leaves the 0시 tile blank. The real weather tool emits `sun` for clear skies at any hour, so midnight shows a sun (`packages/skills/src/tools/weather.ts:24`).
- The top-bar avatar sits on a hard-coded white disc (`ui/Avatar.tsx:89`, `fill="#fff"`). It vanishes into the light capsule and becomes a white sticker in dark mode.
- `Composer.tsx:20` still documents the rejected tab-bar minimise. Delete the comment so nobody restores the behaviour.
- The composer's two trailing 44 px circles (send/mic, call) sit 2 px apart (`chat.css:640`). They meet the minimum, but there is no breathing room between two very different actions.

## Engine and Theme Differences
- **WebKit wraps differently and orphans opening punctuation.** In the call approval, the opening quote “ hangs at the end of the line ("…전할게요: “" / "안녕하세요…") in `webkit-light-08/16/17/19`. In the Meet title it leaves "회의(" alone on line one (`webkit-light-13`, `webkit-dark-14`). Chromium instead breaks inside the code: "abc-" / "defg-hij". Put the quoted script on its own line, and move the meeting code out of the title (see `meeting.md`).
- **WebKit jump capsule:** nearly transparent in `webkit-light-10/11/13`, solid in all Chromium shots. Either the capsule was captured mid-entrance, or the shared bottom `BlurGroup` backdrop doesn't paint under the portalled capsule in WebKit. Verify in a frame recording.
- **Dark mode:** paper already uses the hairline instead of the shadow, so dark already matches DESIGN's Flat Paper target and light is the outlier. The "확인 필요" badge becomes a dark-red block with salmon text and looks louder. The avatar's white disc is visible.
- **Tab bar:** WebKit light shows a brighter double rim along the bar's top edge than Chromium. Cosmetic.

## Questions to Consider
- If each card lost its plate and its inner panel, what would identify a card's type? Is the first line enough ("슬랙 · #design", "아침 브리핑")? The test is whether anyone misses the plates.
- Should the agent's avatar dot mark the start of each assistant turn, instead of icon plates marking each card? It is the one element DESIGN lets carry personality.
- Does a pending phone call need any status pill at all, when its title is already a question and its only primary button is the action?
- Is "최신 메시지" (merely scrolled up) a state the person needs announced, or is "새 메시지" (something arrived) the only one worth glass?
- Should the five keep-for options be one sentence with a default ("7일 동안 보관해요 · 바꾸기") on a card whose job is to get a password typed?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 08, 09, 10, 11, 12, 13, 14, 15, 16, 17.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `low-contrast` | 10 | 08, 09, 10, 11, 12, 13, 14, 15, 16, 17 | 4.4:1 (need 4.5:1) — text #6e6e73 on #efeff0 | **True positive** (`.ccard-badge`): 4.4:1. Put the badge text in `label`. |
| `low-contrast` | 10 | 08, 09, 10, 11, 12, 13, 14, 15, 16, 17 | placeholder 1.9:1 (need 4.5:1) — text #afafb2 on #efeff0 | **Minor.** Every field has a visible label, so this is not blocking. Raise placeholders to about 3:1 (`#8e8e93`). |
| `low-contrast` | 10 | 08, 09, 10, 11, 12, 13, 14, 15, 16, 17 | 3.6:1 (need 4.5:1) — text #ffffff on #0a84ff | **True positive.** Every primary button fails: white on `#0A84FF` is 3.6:1 against the 4.5:1 needed at 17 px semibold. Fix it at token level: the button fill becomes the existing `--accent-text` `#0071E3`, which gives 4.7:1 (slop-inventory §2). |
| `low-contrast` | 10 | 08, 09, 10, 11, 12, 13, 14, 15, 16, 17 | 4.1:1 (need 4.5:1) — text #6e6e73 on #e6e6e9 | **True positive** (`.msg-event`): 4.1:1. Remove the pill and set the note as centred footnote text on the background (4.9:1), or use `label` on the fill. |
| `organic-clip-path` | 14 | 08, 09, 10, 11, 12, 13, 14, 15, 16, 17 | clip-path: path() with 12 curve segments; clip-path: path() with 16 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** low contrast on the event-note pills (A: about 4.1:1; B: 4.1:1 on `.msg-event`).
- **B caught, A missed:** **[P1] Primary buttons fail AA**: white on `#0A84FF` is 3.6:1, on 전화 걸기, 저장하기 and 연결하기 in the credential card. **[P2]** `.ccard-badge` is 4.4:1. **[P3]** The credential-card placeholder is 1.9:1.
- **A caught, B missed:** six glass shapes and the jump capsule covering text; the shared card scaffold (icon plate, nested grey panel, kicker, paper shadow); three colour signals on the call approval; medium-tier approvals that assume 보내기. These are all composition-level tells that the detector's DOM rules don't model.
- **False positives:** `organic-clip-path` (the glass union).

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- **Looked at:** all ten listed screens in chromium-light, chromium-dark and webkit-light; webkit-dark spot checks (`12`, `14`); one crop of `09`/`08` to verify bubble corner radii. Source read: `ThreadView.tsx`, `Messages.tsx`, `StreamText.tsx`, `ToolChips.tsx`, `Composer.tsx`, `chat.css`, `ChatScreens.tsx`, `markdown.tsx`, `util.ts`, `cards/*`, `app/TopBar.tsx`, `app/TabBar.tsx`, `ui/Card.css`, `ui/Button.css`, `ui/Avatar.tsx`, `ui/Icon.tsx`, `ui/TextField.tsx`, plus `screens/more/archive/archive.css` (to confirm the `.md` collision), `apps/server/src/auth.ts` and `apps/server/src/meet.ts` (approval copy).
- **Limits:**
  - Stills only, so no motion findings: the streaming rise, chip morphs and the hold fill were not judged.
  - Card contents are fixture data (`docs/design/impeccable/capture.mjs`). Timings such as "93초" and the blank 0시 tile come from the fixture. The code paths that render them are what is critiqued.
  - The Meet approval was captured already approved, so the pending "보내기" label is read from source, not seen.
  - The detector and the slop inventory were not consulted (isolation rule).
- **Attribution:** rule names quoted from impeccable (Apache-2.0, © Paul Bakaus): craft-floor "nested cards are always wrong", `skill-ban-eyebrow-on-every-section`.
