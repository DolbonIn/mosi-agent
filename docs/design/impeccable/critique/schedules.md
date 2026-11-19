Method: dual-agent (A: critique-a3 · B: impeccable detector over CDP, run by design-director)

# Critique: 일정 (Schedules)

2026-11-12 · Mode: Operate · Screens: `41-schedules`, `42-schedule-sheet`, `16-chat-schedule-card` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Toggles reflect state at once, the next-run line swaps to "다음 실행 없음" when off, and toggle failures drop an island banner. The next-run line itself reads "다음 오늘 오전 7:30". |
| 2 | Match System / Real World | 3 | "예약된 일" and "모닝콜" are natural. There are slips: "다음 오늘", "모시가 예약을 만들어요" on an agent called 깽이, emoji in the chat event line, and "'모닝콜'을(를)". |
| 3 | User Control and Freedom | 3 | Toggle on the row, two-step delete with a plain consequence, and undo from the chat card. A time or wording can't be edited here. Only delete-and-ask-again. |
| 4 | Consistency and Standards | 2 | Two add controls do the same thing. The delete is full-width here but compact in 보관함. The chat card's tile size depends on whether this screen was visited (CSS class collision). The check glyph means both "출석체크" and "마지막 실행". |
| 5 | Error Prevention | 3 | Two-step delete with "지우면 다음 실행부터 멈춰요." Toggles are reversible. The add path prefills a specific sentence that is easy to send by mistake. |
| 6 | Recognition Rather Than Recall | 3 | Rows show name, rule and next run. The sheet shows the exact instruction. Icons are guessed from the title by regex. |
| 7 | Flexibility and Efficiency | 2 | Quick toggles are good. Creating and changing both go through chat. There is no in-place edit and no "지금 실행". |
| 8 | Aesthetic and Minimalist Design | 2 | Icon tiles (including the banned `sparkles`), three-line rows that repeat the time, a recessed fact panel with more tiles, a read-only prompt styled like an input, a full-width pink delete, and a fourth glass shape. |
| 9 | Error Recovery | 3 | Toggle failure shows "켜지 못했어요" / "끄지 못했어요" with the server message, and the toggle reverts. Delete errors show inline. |
| 10 | Help and Documentation | 3 | The hint under the list teaches the real creation path. The empty state offers a primary action and three examples. |
| | **Total** | **27/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** The list is shaped like iOS Alarms: name, rule, a switch on the right, and off rows dimmed. That is exactly right for the job, and it means a fluent iPhone user knows it at a glance. The product-specific part is that schedules are made by asking the agent, and that the chat answers with a card carrying the same switch. "Done, then shown" applies to recurring work. What is generic is the decoration: a grey rounded tile per row whose glyph is guessed from the title (sun for 모닝, check for 출석, `sparkles` for 브리핑), and a sheet that stacks a recessed panel of icon-tile facts over a faux text field over a full-width destructive button. The sheet could belong to any task app.

**Deterministic scan.** Pending: Assessment B is joined by design-director.

## Overall Impression
Solid and calm, with the right iOS bones and honest state. The weak spot is the entry point. Two "+" controls (one of them a glass circle in the top bar) both throw the person into chat with "매일 7시 30분에 깨워줘" already typed, under a hint that calls the agent "모시". The biggest opportunity is to make creation say where it goes, and to strip the rows and sheet down to the words. Name, rule and next run already say everything the tiles try to.

## What's Working
- **Alarms-grade rows.** The toggle is on the row only, the title dims and the next run becomes "다음 실행 없음" when off, and the times are tabular. The `ContentSwap` on the next-run text (`SchedulesScreen.tsx:108-111`) is the small, state-tied motion the user wants kept.
- **The record lives in the conversation.** The chat card carries the same switch, rolls back on failure and turns into "예약을 취소했어요" after undo (`InfoCards.tsx:197-241`). The sheet's note says exactly what deletion does and doesn't do ("지난 결과는 대화에 그대로 남아요").
- **Creation teaches the real mechanism.** The hint and the empty-state examples show that you make a schedule by saying it (`SchedulesScreen.tsx:30, 56-72, 84`). That is more honest than a form the agent would have to second-guess.

## Priority Issues

**[P1] Two add controls drop the person into chat with someone else's sentence**
- **What:** The top bar's right glass circle "+" and the "+ 새 예약 만들기" button both call `nav.compose("매일 7시 30분에 깨워줘")`. The hint below says "…처럼 말하면 모시가 예약을 만들어요". The agent is 깽이, and "깨워줘" is spaced differently from every other prompt in the app ("깨워 줘", "브리핑해 줘").
- **Why it matters:** "새 예약 만들기" promises a form, and the person lands in chat with a morning-call sentence they didn't write. Sending it creates a 7:30 call. The duplicate "+" is also a fourth glass shape on screen (back, name capsule, "+", tab bar), past DESIGN's "≤3 glass" rule, for an action the content already offers. Naming the brand where the agent's name belongs breaks principle "The agent says what it will do" and the name rule (agent names are the user's).
- **Fix:** Remove the top-bar "+" (`useTopBarRight` at `SchedulesScreen.tsx:44`). The in-content button stays the one add action. Relabel it to say where it goes, matching 보관함's empty CTA: "{agent}에게 예약 부탁하기" (`josa`-safe: `${agentName}에게`). Keep the compose flow. The hint becomes `"매일 7시 30분에 깨워 줘"처럼 말하면 ${josa(agentName, "이가")} 예약을 만들어요.` Fix `NEW_PROMPT` spacing to "매일 7시 30분에 깨워 줘".
- **Evidence:** `41`, `42` (all engines and themes; the "+" is visible behind the scrim in `42`). `SchedulesScreen.tsx:29`, `:44`, `:80-85`.

**[P2] Icon tiles with guessed glyphs, including `sparkles`, on rows, facts and the chat card**
- **What:** Each row has a 32 px r9 `--fill` tile whose glyph is chosen by regex on the title: sun, checkmark, or `sparkles` for anything with 브리핑/뉴스. The sheet's facts each get a 30 px r9 tile (clock, calendar, check), and "마지막 실행 · 아직 없어요" is marked with a check. The chat card adds a clock tile.
- **Why it matters:** The Direction removes icon tiles from schedule heads by name, and DESIGN bans `sparkles` as the symbol for "the agent / a task". A guessed glyph can be wrong: a check next to "아직 없어요" asserts something that didn't happen. The tile column also forces the row separator to start at 60 px.
- **Fix:** Delete `iconFor` and the `.sched-icon` span (`SchedulesScreen.tsx:32-39, 102-104`). Rows start with the title at the 16 px gutter. Move the separator inset to `left: 16px` (`schedules.css:11`). In the sheet, render `Fact` without the icon (`SchedulesScreen.tsx:179-191`). On the chat card, drop the clock tile (`InfoCards.tsx:204-206, 215-217`). The card is "title / rule" plus the switch, and needs nothing more.
- **Evidence:** `41`, `42`, `16` (all). `SchedulesScreen.tsx:32-39`, `schedules.css:41-51`, `more.css:167-176`, `cards.css:300-309`.

**[P2] Each row says the time twice and reads "다음 오늘"**
- **What:** Rows are three lines: "모닝콜" / "매일 오전 7:30" / "다음 오늘 오전 7:30". The second line is 15 px in `--label`, almost as strong as the title.
- **Why it matters:** For daily rules the third line repeats the second, and "다음 오늘" isn't Korean. Three similar-weight lines per row make the list noisy for three items. Rows should be glanceable (operating context: short bursts).
- **Fix:** Two lines. Title (17/600), then one meta line in footnote `--label-2`, tabular: "매일 오전 7:30 · 다음은 오늘". Use the day part of `whenKo` ("오늘" / "내일" / "11월 14일"), since the time is already in the rule. When off, show "매일 오후 9:30 · 꺼져 있어요". Keep the `ContentSwap` on the changing part (`SchedulesScreen.tsx:95, 106-111`; `schedules.css:69-76`).
- **Evidence:** `41` (all engines and themes). `SchedulesScreen.tsx:95`, `:107-111`.

**[P2] The sheet: facts in a recessed panel, the instruction styled like an input, and delete dominating**
- **What:** In `42` the sheet shows a `--surface-2` panel of three icon-tile facts, then "깽이에게 맡긴 일" over a filled r16 box that looks exactly like a text field but is a read-only `<p>`, then a 52 px full-width pink "예약 지우기". In 보관함 the same destructive confirm is a compact centered capsule.
- **Why it matters:** "No card inside a card" and the Direction's "recessed blocks become rows". A read-only box styled as a field invites a tap that does nothing. The biggest, most saturated element in the sheet is the destructive one, so the visual hierarchy points at "delete". Two sheets with the same action shape it differently (consistency).
- **Fix:** Facts become plain label/value rows on paper with hairlines and no panel (`more-sheet-rows` background off for this sheet). The instruction renders as quoted body text, “7시 30분에 전화로 깨워 줘”, in `--label` with no fill, so it reads as what was asked and not as an input (`.sched-prompt`, `schedules.css:99-109`). `ConfirmButton` gets `fullWidth={false}` and `size="md"`, centered like 보관함's (`SchedulesScreen.tsx:171`). The note stays under it.
- **Evidence:** `42` (all). `SchedulesScreen.tsx:147-155`, `:171`, `schedules.css:99-109`, `more.css:129-139`, `archive/ArtifactSheet.tsx:145-155` (the compact precedent).

**[P2] The chat side: class collision, emoji and a josa placeholder in strings the person reads**
- **What:** (a) `.sched-icon` and `.sched-title` are global classes defined in both `cards.css` (chat card: 40 px, r12, `--surface-2`) and `schedules.css` (list: 32 px, r9, `--fill`, `margin-top: 2px`). The schedules CSS arrives with the lazy schedules chunk, so after a visit the chat card's tile becomes the list's. `16` already shows a 32 px tile where `cards.css` declares 40 px. (b) The server writes the run marker into the conversation as `⏰ ${s.title} · ${s.human}` and the morning briefing as `☀️ 오늘의 브리핑`. (c) The skipped-run notification says `'${s.title}'을(를) 실행하지 못했어요` although `eulReul` exists in `util.ts`.
- **Why it matters:** The same card looks different depending on navigation history (consistency). DESIGN: "No emoji as UI anywhere the app renders text it controls (server event strings included)". "을(를)" is the machine-template tell that principle 5 (Korean first, josa handled) exists to prevent.
- **Fix:** (a) Namespace the chat card classes (`ccard-sched__title`, `ccard-sched__when`). If the tile goes (previous issue), delete both `.sched-icon` rules. (b) Event text becomes `${s.title} · ${s.human}` and `오늘의 브리핑`. The centered `msg-event` line already marks it as an event (`Messages.tsx:52-57`). (c) Use `${eulReul(s.title)}`, giving "'모닝콜'을 실행하지 못했어요".
- **Evidence:** `16` (chromium and webkit, light and dark: the schedule tile measures about 32 px against the 44 px artifact tile above it). `cards.css:300-324`, `schedules.css:41-51, 63-68`, `screens/more/register.ts:21` (lazy chunk), `apps/server/src/schedules.ts:291`, `:302`, `:341`, `apps/server/src/util.ts:56`.

## Cognitive Load
- **Checklist failures (1, low):** *Visual hierarchy.* In the sheet, the destructive button outranks the facts and the instruction. In the rows, the rule line competes with the title.
- **Decision points with >4 visible options:** none. The list has three rows, each with one switch. The empty state offers one primary and three examples (4).

## Emotional Journey
Opening 예약된 일 is reassuring: three things, three switches, clearly on or off. Flipping a switch is the high point, instant and reversible. The valley is creating: "새 예약 만들기" leads somewhere unexpected, with words already typed. Opening a schedule ends on a large pink "예약 지우기", so by the peak-end rule the last impression of looking closer at something you set up is "delete it". The chat card is a good ending to the original request (the switch is right there), apart from a tile that changes size after you visit this screen.

## Persona Red Flags
**Casey (Distracted Mobile):** One add control is the glass "+" at the top right, the least reachable spot one-handed. The thumb-zone version is the in-content button, which is why the top one should go. A prefilled "매일 7시 30분에 깨워줘" plus a stray tap on send creates a morning call she didn't ask for.

**Jordan (First-Timer):** "새 예약 만들기" → chat, with a sentence about waking up. He wanted a briefing. The sheet's instruction box looks editable, so he taps it to change "7시 30분" and nothing happens. "다음 오늘 오전 7:30" reads like a typo.

**Sam (Accessibility):** Row and toggle are separate targets with good labels ("모닝콜 켜기"). The sheet's prompt box looks like a field, but VoiceOver reads it as plain text. That mismatch disappears when it is styled as text. The emoji in the event line is read aloud as "알람 시계" before the schedule name.

**Project persona: Between-errands delegator "지수"** (PRODUCT.md: schedules recurring work such as morning call, briefing and attendance check; one-handed, short bursts). *Red flags:* The hint calls the agent "모시" while her agent is 깽이, so she wonders whether that is someone else. She wants to move 출석체크 from 9:00 to 8:50 and finds no way in the sheet except deleting it and asking again.

## Minor Observations
- The literal radii `.sched-icon` 9 and `.sched-prompt` 16 (`schedules.css:48, 101`) go once the tile and the faux field go.
- The sheet's 다음 실행 fact says "꺼져 있어요" when off, while the row says "다음 실행 없음". Pick one.
- The chat card shows the name and rule but not what will be done ("날씨랑 뉴스"). The sheet shows the instruction, and the card could show it as its second line. See Questions.
- Server validation strings mix developer terms into Korean ("무엇을 할지(prompt)가 필요해요", "enabled는 true/false여야 해요", `apps/server/src/schedules.ts:117, 179`). These are mostly read by the agent tool, but an island error banner would show them verbatim.
- The empty state's chips are full sentences (`SchedulesScreen.tsx:65-69`). They are choices, so chips are allowed, but they wrap like prose. Not captured.

## Engine and Theme Differences
- No material Chromium/WebKit differences on `41`/`42`. Wrapping, toggles and the sheet match.
- **Dark:** the tiles turn into near-black squares and the `sparkles` glyph reads even more like an AI badge on the dimmed 저녁 브리핑 row. The toggles' accent is unchanged. The avatar dot sits on a white disc in the name capsule (shared chrome).
- **`42` in every engine:** the 모닝콜 row is blank behind the scrim while the sheet is open. That is the sheet-from-source primitive hiding its source, as MOTION-SPEC §3 intends, and not a bug.
- **`16` WebKit:** the approval card's quote opens at the line end ("…전할게요: “"), a WebKit wrap difference in a neighbouring card, outside this feature.

## Questions to Consider
- Should the sheet let the person change the time and wording in place (a time picker row and an editable instruction), or is "ask 깽이 again" the product's deliberate single path? If it is deliberate, a "{agent}에게 바꿔 달라고 하기" action in the sheet would say so.
- Would the chat card be a better record with the instruction as its second line (“날씨랑 뉴스 브리핑해 줘” · 매일 오전 7:00)?
- Is a "지금 한 번 실행하기" action worth a row, so a person can check that a new 모닝콜 works without waiting until 7:30?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 41, 42, 16.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `skipped-heading` | 2 | 41, 42 | <h1> "보관함" followed by <h3> "11월 12일 주간회의 회의록" (missing h2) | **True positive.** `SectionLabel` renders `<h3>` straight after the page `<h1>` (`screens/more/parts.tsx:93`), so VoiceOver's heading rotor skips a level. Make it `h2`. |
| `organic-clip-path` | 4 | 16, 41, 42 | clip-path: path() with 12 curve segments; clip-path: path() with 16 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |
| `low-contrast` | 1 | 16 | 4.4:1 (need 4.5:1) — text #6e6e73 on #efeff0 | **True positive** (`.ccard-badge`): 4.4:1. Put the badge text in `label`. |
| `low-contrast` | 1 | 16 | placeholder 1.9:1 (need 4.5:1) — text #afafb2 on #efeff0 | **Minor.** Every field has a visible label, so this is not blocking. Raise placeholders to about 3:1 (`#8e8e93`). |
| `low-contrast` | 1 | 16 | 3.6:1 (need 4.5:1) — text #ffffff on #0a84ff | **True positive.** Every primary button fails: white on `#0A84FF` is 3.6:1 against the 4.5:1 needed at 17 px semibold. Fix it at token level: the button fill becomes the existing `--accent-text` `#0071E3`, which gives 4.7:1 (slop-inventory §2). |
| `low-contrast` | 1 | 16 | 4.1:1 (need 4.5:1) — text #6e6e73 on #e6e6e9 | **True positive** (`.msg-event`): 4.1:1. Remove the pill and set the note as centred footnote text on the background (4.9:1), or use `label` on the fill. |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** the heading-structure note.
- **B caught, A missed:** **[P2]** heading skip `<h1>` 예약된 일 → `<h3>`. **[P1]** white on accent on the chat schedule card's thread, from shot 16.
- **A caught, B missed:** two add controls (the top-bar + is a 4th glass shape); sparkles and guessed icon tiles; the global `.sched-icon` class collision; emoji in the server event strings.
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- Looked at: chromium-light, chromium-dark and webkit-light for `41`, `42` and `16`. Spot-checked webkit-dark `41`. Read `SchedulesScreen.tsx`, `schedules.css`, `parts.tsx` / `more.css` (sheet rows), the `ScheduleCard` in `screens/chat/cards/InfoCards.tsx` with its `cards.css` rules, `screens/chat/Messages.tsx` (how event text renders), and `apps/server/src/schedules.ts` (event, notification and validation strings).
- Limits: stills only. The tile size in `16` was measured from a crop of the JPEG (about 64 px at @2x, so about 32 px), not from computed styles. The capture harness's visit order is unknown, so the collision is inferred from source plus that measurement. The empty state and the "결과가 오는 대화 보기" button (needs `threadId`) were not captured. Detector not run (isolation rule). Nothing under `apps/` was modified.
