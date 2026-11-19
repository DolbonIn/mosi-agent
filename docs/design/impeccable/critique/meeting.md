Method: dual-agent (A: critique-a1 · B: impeccable detector over CDP, run by design-director)

# Critique: 회의 참여 (Meeting attendance: Meet approval card, meeting notes, summary)

2026-11-12 · Mode: Operate · Screens: `13-chat-meet-approved`, `14-chat-meeting-events`, `15-chat-meeting-summary-artifact` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Every state change is narrated in plain 해요체: "참여 요청을 보냈어요. 호스트가 수락하면 들어가요." → "회의에 들어왔어요…" → "회의가 끝나서 나왔어요." There is no persistent "in a meeting now" marker; the notes are the only sign. |
| 2 | Match Between System and Real World | 2 | Joining a meeting is presented as sending a message: a paper-plane glyph, a "보낼 내용" label, and "보내기" as the pending button. The meeting's thread is a `call` kind, so it gets a phone glyph. |
| 3 | User Control and Freedom | 2 | 취소 exists before approval. After the agent is in a room with other people, the only way out is to type a request and hope the model calls `sys_leave_meet`. |
| 4 | Consistency and Standards | 2 | The approval tier vocabulary is misapplied. Minutes opened from chat use a different sheet from minutes opened in 보관함. The summary's spacing comes from the archive stylesheet. |
| 5 | Error Prevention | 3 | Explicit consent, disclosure to attendees, and host admission all stand between the request and the room. |
| 6 | Recognition Rather Than Recall | 3 | The meeting code is in the card, and the artifact meta tells you what's inside ("참석 4명 · 42분 · 정한 것 2 · 할 일 2"). |
| 7 | Flexibility and Efficiency of Use | 2 | No share or copy for minutes opened from chat. No quick exit from the meeting. |
| 8 | Aesthetic and Minimalist Design | 2 | A recessed panel with a kicker inside the approval card. A doc plate and a "문서" kicker on the artifact. Grey pills for every note. A summary with no hierarchy. |
| 9 | Error Recovery | 2 | Denied, blocked, invalid code and failure are all posted as the same grey note as progress, with no recovery action. |
| 10 | Help and Documentation | 3 | The in-meeting note teaches the wake word exactly when it matters: "회의 중에 '깽이야'라고 부르면 대답해요." |
| | **Total** | **24/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** What the feature does is specific and considerate. The agent tells attendees it is an AI assistant before anything else ("참석자들에게는 AI 비서라고 먼저 알려요"; the bot announces "…님의 AI 비서 깽이예요", `apps/server/src/meet.ts:605`). The host must admit it. The wake word uses the agent's own name with the right vocative particle (`josa(agent, "아", "야")`, `meet.ts:907`). It posts minutes and a summary.

How the feature looks is borrowed from other features, and none of it is specific to meetings. The approval is the message-send template (paper plane, "보낼 내용" panel). The notes are generic grey system pills. The minutes arrive as a generic document tile. The meeting's own thread borrows the phone-call kind. A meeting has the most at stake socially of all of 모시's jobs (other people see the agent), yet nothing on these screens shows it is happening in a room with others.

**Deterministic scan.** See Assessment B.

## Overall Impression
The words are right and the shapes are wrong. The consent copy, disclosure and status narration are some of the best writing in the app. They sit inside a send-message approval, grey chips and a flat wall of bullets. The single biggest opportunity: once the agent is in someone else's meeting, give the person one obvious way to see it is there and to pull it out. Everything else on these screens is cleanup.

## What's Working
- **Consent that includes the other people in the room.** The approval detail says what the agent will do and what attendees will be told: "깽이가 이 회의에 참여해 듣고 받아 적어요. 참석자들에게는 AI 비서라고 먼저 알려요." (`meet.ts:1595`). The bot's spoken announcement matches it (`meet.ts:605`). This is Principle 2 extended to third parties.
- **Status narration in plain Korean, with help at the right moment.** Each note says what happened and what happens next ("참여 요청을 보냈어요. 호스트가 수락하면 들어가요.", `meet.ts:408`). The in-call note teaches the wake word right when it becomes usable (`meet.ts:907`). Failure notes are specific: "같은 조직 계정만 들어갈 수 있는 회의일 수 있어요." (`meet.ts:411`).
- **A record with meaningful meta.** The artifact card summarises the minutes in one line, "참석 4명 · 42분 · 정한 것 2 · 할 일 2" (`15`), and opens a sheet that morphs from the card (`ArtifactCard.tsx:24`). That is "Done, then shown".

## Priority Issues

**[P1] Joining a meeting is dressed as sending a message: paper plane, "보낼 내용", "보내기"**
- **What:** `riskOf` has no rule for `sys_join_meet`, so it falls to "medium" (`screens/chat/util.ts:62-70`). The medium tier draws:
  - a paper-plane glyph (`ApprovalCard.tsx:66`; the server declares `icon: "people"` for this tool, `meet.ts:1588`, but it is ignored);
  - a recessed panel labelled "보낼 내용" around text that is not sent anywhere (`ApprovalCard.tsx:89-93`, `cards.css:352-364`);
  - a pending primary labelled "보내기" (`ApprovalCard.tsx:121`).

  The title puts the meeting code inside the sentence, "Google Meet 회의(abc-defg-hij)에 참여할까요?" (`meet.ts:1594`). Chromium breaks inside the code ("abc-" / "defg-hij"), and WebKit leaves "회의(" alone at the end of line one (`webkit-light-13`, `webkit-dark-14`).
- **Why it matters:** This is the consent moment for putting an AI into a room with other people. PRODUCT lists it among the high-stakes moments. The verb on the button has to be the action ("참여하기"), not a neighbouring one. DESIGN also bans the kicker and the nested panel.
- **Fix:**
  - Derive glyph and verb from the tool. For `sys_join_meet`: the tool's `people` glyph inline at 17 px in `--label-2` (no plate), and the button "참여하기".
  - Render the detail as `.appr-detail` body text, with no panel and no "보낼 내용".
  - Retitle the card "Google Meet 회의에 참여할까요?" and put the code on the detail's first line as `abc-defg-hij` in a `white-space: nowrap` tabular span, so it never breaks.
  - (Tier question below.)
- **Evidence:** `13`, `14` in all engines and themes. `util.ts:62-70`, `ApprovalCard.tsx:66`, `89-93`, `121`, `meet.ts:1576`, `1588`, `1594-1595`, `cards.css:352-364`.

**[P1] Once the agent is in the meeting, the person has no visible way to pull it out**
- **What:** The mobile app has no meeting-specific UI at all (`apps/mobile/src` has no meet or meeting references). Leaving exists only as an LLM tool, `sys_leave_meet` (`meet.ts:1621-1627`). The notes are inert text rows (`Messages.tsx:52-57`). To get the agent out, the person must find the right thread ("회의 참여"), type something like "회의에서 나와 줘", and wait for a model turn.
- **Why it matters:** Nielsen's emergency exit, at the moment with the most social exposure in the product. Colleagues can see "깽이" in their meeting. If the person changes their mind, the exit should be one tap, not a sentence and a model turn.
- **Fix:**
  - While the meeting is live, show one neutral plain button, "회의에서 나가기" (`tone="neutral"`, 44 px), on the newest state note (the "회의에 들어왔어요…" row). It calls the existing leave path (`core.meet.leave`); the server needs a thin route over it.
  - Pin the drawer's thread badge "회의 중", the same pattern MOTION-SPEC §8.10 uses for "통화 중".
  - This adds no new flow. It surfaces a function that already exists.
- **Evidence:** `14` (notes, no control). `meet.ts:1621-1627`, `Messages.tsx:52-57`. A search of `apps/mobile/src` for "meet" returns nothing.

**[P2] Every note is the same grey pill, failures included, and the pills miss AA in light mode**
- **What:** `.msg-event` is a filled rounded rectangle with 13 px `--label-2` text on `--fill` (`chat.css:211-220`). Over `--bg` in light, that is about 4.1:1 by token math, under 4.5:1. The server posts progress and failure through the same channel:
  - progress: "참여하러 갈게요", "들어왔어요" (`meet.ts:603`, `907-909`);
  - failure: "호스트가 참여 요청을 받아 주지 않았어요.", "회의를 찾을 수 없어요…", "회의에 참여하지 못했어요…" (`meet.ts:407-429`, `620`); "회의 요약을 만들지 못했어요." (`meet.ts:1297`).

  `Messages.tsx:52-57` renders them all identically, with no tone and no action.
- **Why it matters:** "Never colour alone" cuts both ways: here there isn't even colour. A denied admission looks exactly like a successful one at a glance. DESIGN also lists "event notes" among the chips that should become plain text.
- **Fix:**
  - Notes become plain centred footnote text with no fill: `--t-footnote`, `--label-2` on `--bg` (≥4.5:1 per tokens), 4 px vertical rhythm between consecutive notes.
  - Failure notes carry a tone flag from the server and render with the `exclamation` glyph at 14 px and `--danger` text.
  - Where a retry makes sense (failed, invalid code), add a neutral plain "다시 참여하기" that re-runs the original request.
- **Evidence:** `13`, `14` (light: low contrast; dark: blue-grey pills). `chat.css:211-220`, `Messages.tsx:52-57`, `meet.ts:407-429`, `603`, `620`, `907-909`, `1297`.

**[P2] The summary has no hierarchy, and the minutes card wears a plate and a kicker**
- **What:**
  - *Summary.* The server prefixes "**회의 요약**" (`meet.ts:1300`) and asks the model for bold-only section lines over bullets ("**결정 사항**", "**할 일**", "**다음 일정**", `meet.ts:1349-1361`). The fixture in `15` has the same shape. The chat markdown parses a bold-only line as an ordinary paragraph (`markdown.tsx:158`). The archive stylesheet's global `.md > * + * { margin-top: 0.75em }` then wins in the thread (`screens/more/archive/archive.css:473-475` over `chat.css:333-338`). Every block in `15` is about 40 px from the next, bullets included. The title "회의 요약" and the section heads are the same size and weight, and each head sits as far from its own bullets as from the previous section.
  - *Card.* The artifact card adds a 44 px doc plate and a "문서" kicker above the title (`ArtifactCard.tsx:27-31`, `cards.css:504-523`).
- **Why it matters:** The summary is the payoff of the whole feature. Without grouping (more space above a heading than below), "할 일" doesn't read as a list of tasks you can scan. impeccable's craft floor bans an eyebrow above a heading, and DESIGN bans icon tiles.
- **Fix:**
  - Scope the archive's markdown rules to `.arc-doc .md` so the thread keeps its 4 px block rhythm.
  - In `markdown.tsx:158`, render a line that is only `**…**` as `md-h3`: 600 weight, 16 px above, 4 px below. Render the first one ("회의 요약") as `md-h2` in `--t-title3`.
  - Artifact card: drop the plate and the "문서" kicker. Put a 17 px `doc` glyph inline before the title in `--label-2`, and keep the meta line.
- **Evidence:** `14`, `15` in all engines and themes. `meet.ts:1300`, `1349-1361`, `markdown.tsx:158`, `archive.css:466-475`, `chat.css:327-338`, `ArtifactCard.tsx:27-31`, `cards.css:504-523`.

**[P2] Minutes opened from chat get a second, poorer sheet than minutes opened in 보관함**
- **What:** `ArtifactCard` opens its own `ArtifactBody` (`ArtifactCard.tsx:24`, `40-72`). It has no 공유하기, 복사하기 or 보관함에서 지우기, its meta is "· 보관함에 저장됨", it shows a 3-line skeleton, and it uses the chat markdown. The archive opens `ArtifactView` (`screens/more/archive/ArtifactSheet.tsx:34-40`, `101-158`), which has share, copy, delete, `withoutTitle`, "N분 전 수정" and a 6-line skeleton. The two `KIND` tables disagree as well: `table` uses `doc` vs `chart`, and `checklist` uses `check-circle` vs `checkmark` (`ArtifactCard.tsx:15-20` vs `ArtifactSheet.tsx:17-22`).
- **Why it matters:** The first thing most people do with meeting minutes is send them to the attendees, and from the chat, where the minutes arrive, they can't. The same document also looks and behaves differently depending on the door you came through.
- **Fix:** `ArtifactCard` calls `openArtifact(artifact, el)` from `ArtifactSheet.tsx`, loading the artifact first if needed. Delete `ArtifactBody`/`Dashboard` from `ArtifactCard.tsx` and keep one `KIND` table.
- **Evidence:** `15` (card). `ArtifactCard.tsx:15-20`, `24`, `40-72`, `ArtifactSheet.tsx:17-22`, `34-40`, `101-158`.

## Cognitive Load
Checklist failures (3, moderate):
- **Visual hierarchy:** fails. Summary heads and bullets have the same weight and spacing, and failure notes look like progress notes.
- **Grouping:** fails. Summary sections don't group (equal space above and below each head).
- **Working memory / context switch:** fails, read from source and not visible in the fixture. The approval is in the thread where you asked, but `join` creates a new "회의 참여" thread and posts every note and the summary there (`meet.ts:593-603`, `1300`). Every meeting thread has the same title, "회의 참여". To follow a meeting, the person has to leave the conversation where they asked, then find the right identically-named thread.

Passing: single focus (the approval is one decision), chunking, one thing at a time, minimal choices, progressive disclosure.

Decision points with >4 visible options: none.

## Emotional Journey
- **Ask:** "이 회의 들어가서 받아 적어 줘 + link". Easy.
- **Consent (`13`):** the copy is reassuring and honest (it discloses to attendees). The surface undercuts it: a paper plane and "보낼 내용" make it feel like the agent is about to message someone, and the pending verb would be "보내기".
- **Waiting for admission:** the notes keep the person informed, which is good.
- **In the meeting:** the highest-anxiety valley. The agent is in front of colleagues, and the only sign is a grey note in a thread somewhere. There is no persistent presence and no exit button.
- **End (`14`, `15`):** "회의가 끝나서 나왔어요." then the summary. The payoff arrives as a flat wall of evenly spaced lines, and the minutes card can't be shared from where it lands. The peak-end close is weaker than the work behind it.

## Persona Red Flags
**Riley (Deliberate Stress Tester):** Pastes a wrong code. Gets "회의를 찾을 수 없어요. 회의 코드가 맞는지…" as a grey pill identical to success notes, with no retry. Asks for two meetings in one day and gets two threads both titled "회의 참여", each with a phone glyph (`util.ts:81`; meetings are created as `kind: "call"`, `meet.ts:595`). Opens the minutes from chat, looks for 공유하기, and finds none.

**Casey (Distracted Mobile User):** Sends 깽이 into a meeting while commuting, then wants it out because the meeting turned sensitive. Has to find the "회의 참여" thread, type a sentence, and wait for a turn, with one hand, on a bus.

**Sam (Accessibility-Dependent User):** The light-mode notes are about 4.1:1 at 13 px. Failure and success notes have the same role and presentation, so a screen reader can't tell them apart either (no `role="alert"` on failures).

**Project persona: The meeting proxy, "하은"**
- *Profile (from PRODUCT.md Users, Operating Context and Principles):* non-technical; hands everyday chores to 깽이; "letting the agent into a meeting with other people" is one of her high-stakes moments; cares how the agent represents her.
- *Behaviors:* pastes a Meet link from a calendar invite, approves, checks back once mid-meeting, reads the summary afterwards and forwards it.
- *Red flags:* the approval button says "보내기" when she is letting it into a room; there is no glanceable sign it is still in the meeting; she can't pull it out with one tap; she can't forward the minutes from where they arrive.

## Minor Observations
- Meeting threads are created as `kind: "call"` (`meet.ts:595`), so the thread intro shows `phone-out` (`util.ts:78-84`, `ChatScreens.tsx:67`), even though the thread row carries `icon: "people"`. Use the thread's own icon.
- All meeting threads are titled "회의 참여". Add the date or the code to the subtitle ("11월 12일 · abc-defg-hij").
- Seen in the fixture, where the summary and the minutes card arrive together: the card's meta ("정한 것 2 · 할 일 2") repeats counts the summary just listed. In production the minutes are created only on request (`meet.ts:1510`), so the overlap only happens when asked. Fine, but don't add more meta.
- The approved receipt in `13` shows "승인했어요" without the time or the "이 기기의 키로 확인했어요" line. That is fixture state (no `decidedAt`), not a defect; verify on a real approval.
- Dark mode notes take a blue-grey cast (`--fill` over the dark wallpaper light). With plain text instead of pills, the tint question goes away.

## Engine and Theme Differences
- **Title break:** Chromium breaks the code ("abc-" / "defg-hij"), and WebKit orphans the parenthesis ("회의(" / "abc-defg-hij)에…"). Both go away if the code leaves the title.
- **Jump capsule:** in `webkit-light-13` it is nearly transparent over the notes, and its label collides with "참여 요청을 보냈어요"; Chromium's is solid (see `chat.md`).
- **Dark:** the notes' fill turns blue-grey and the panel inside the approval card gets darker. Otherwise both themes are equivalent.

## Questions to Consider
- Is letting an AI into a meeting with other people a medium-risk action? MOTION-SPEC §8.6 treats "calling a third party" as high-risk, and a meeting is a third party times N. Should it take the hold-or-two-tap confirm?
- Should the meeting's notes and summary land in the thread where the person asked, with the "회의 참여" thread kept as the full transcript, so the person never has to go looking?
- What would show "깽이 is in a meeting right now" at a glance? The island already owns live agent state (`call`, `tool`). Should a meeting be one more island state, with tap to open the thread and leave?
- Should the summary be the artifact, with the thread showing only "한 줄 요약" plus the minutes card, instead of the same content set twice in two places?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 13, 14, 15.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `low-contrast` | 3 | 13, 14, 15 | 4.4:1 (need 4.5:1) — text #6e6e73 on #efeff0 | **True positive** (`.ccard-badge`): 4.4:1. Put the badge text in `label`. |
| `low-contrast` | 3 | 13, 14, 15 | placeholder 1.9:1 (need 4.5:1) — text #afafb2 on #efeff0 | **Minor.** Every field has a visible label, so this is not blocking. Raise placeholders to about 3:1 (`#8e8e93`). |
| `low-contrast` | 3 | 13, 14, 15 | 3.6:1 (need 4.5:1) — text #ffffff on #0a84ff | **True positive.** Every primary button fails: white on `#0A84FF` is 3.6:1 against the 4.5:1 needed at 17 px semibold. Fix it at token level: the button fill becomes the existing `--accent-text` `#0071E3`, which gives 4.7:1 (slop-inventory §2). |
| `low-contrast` | 3 | 13, 14, 15 | 4.1:1 (need 4.5:1) — text #6e6e73 on #e6e6e9 | **True positive** (`.msg-event`): 4.1:1. Remove the pill and set the note as centred footnote text on the background (4.9:1), or use `label` on the fill. |
| `organic-clip-path` | 4 | 13, 14, 15 | clip-path: path() with 12 curve segments; clip-path: path() with 16 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** **strong agreement** on the grey note pills (A about 4.1:1, B 4.1:1 on `.msg-event`).
- **B caught, A missed:** **[P1]** primary-button fill 3.6:1. **[P2]** `.ccard-badge` (승인했어요) is 4.4:1.
- **A caught, B missed:** joining a meeting presented as sending a message (paper plane, 보낼 내용, 보내기); no visible way to pull the agent out of a live meeting; failures styled the same as notes.
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- **Looked at:** `13`, `14`, `15` in chromium-light, chromium-dark and webkit-light; webkit-dark `14`. Source: `screens/chat/cards/ApprovalCard.tsx`, `cards/ArtifactCard.tsx`, `cards/cards.css`, `chat.css` (`.msg-event`, `.md`), `Messages.tsx`, `markdown.tsx`, `util.ts` (risk tiers, kind icons), `screens/more/archive/ArtifactSheet.tsx`, `screens/more/archive/archive.css` (markdown collision), and `apps/server/src/meet.ts` (approval copy, state notes, thread creation, summary prompt, leave tool).
- **Limits:**
  - Stills only.
  - The fixture puts the notes and the summary in the main thread. Production creates a separate "회의 참여" thread, so the context-switch point is read from source, not seen.
  - The Meet card was captured already approved, so the pending "보내기" verb is read from `ApprovalCard.tsx:121` and `util.ts:62-70`.
  - Contrast is computed from token values.
  - The detector and the slop inventory were not consulted (isolation rule).
- **Attribution:** rule names quoted from impeccable (Apache-2.0, © Paul Bakaus): `skill-ban-eyebrow-on-every-section`, craft floor "more space above a heading than below it".
