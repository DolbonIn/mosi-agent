Method: dual-agent (A: critique-a2 · B: impeccable detector over CDP, run by design-director)

# Critique: 서랍 (Drawer: threads, search, friends, nav)

2026-11-12 · Mode: Operate · Screens: `20-drawer`, `21-drawer-search` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Unread dots, relative times and the current-thread highlight work. The "승인 대기 / 통화 중" badges exist in code, but they only appear for threads whose messages are already loaded in memory. Three of five subtitles are static type labels ("깽이의 외부 통화"), not state. |
| 2 | Match Between System and Real World | 3 | Mostly plain. "나만의 AI 에이전트" under the name is tech jargon the rest of the app avoids. |
| 3 | User Control and Freedom | 3 | 취소 and a clear-× in search, Esc, tap-the-card and edge-swipe all close. Archiving has an undo banner. |
| 4 | Consistency and Standards | 2 | The meeting thread shows the phone-call glyph. Tasks use `sparkles`. The archived-threads toggle uses the same archive glyph as the 보관함 tab two rows below it, for a different thing. |
| 5 | Error Prevention | 3 | Nothing destructive happens in the drawer itself; archive is reversible. |
| 6 | Recognition Rather Than Recall | 2 | "회의 참여" doesn't say which meeting. Subtitles repeat the thread type. An empty search query shows a blank pane instead of recent threads. The archive toggle is icon-only. |
| 7 | Flexibility and Efficiency of Use | 3 | 초성 matching (ㅎㅇ → 회의 참여), ↑/↓ + Enter, edge-swipe open. The ⌘K shortcut that MOTION-SPEC §3 mentions isn't wired (no handler in `apps/mobile/src`). |
| 8 | Aesthetic and Minimalist Design | 3 | A calm list overall. White icon plates, a sparkles glyph and a solid-accent search result add avoidable noise. |
| 9 | Help Users Recognize, Diagnose, and Recover from Errors | 3 | Thread-load errors render inline. "찾는 대화가 없어요" names the outcome but offers no next step. |
| 10 | Help and Documentation | 2 | No help, which is fine for a nav surface. The empty states are short ("일을 맡기면 여기에 대화가 생겨요" is good; search's empty line is not). |
| | **Total** | **26/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** The structure is product-specific and well judged. MOTION-SPEC §8.10's "conversation-first" drawer is visible: 기본 채팅 and 친구 first, then the agent's side threads (calls, meetings, tasks, schedules, friend chats), with the tab destinations collapsed into one compact row instead of a second tab bar. The 초성 search is a real Korean-first touch that no ported template would have.

The rows themselves are the generic chat-app list: a rounded white icon tile, a bold title, a grey subtitle and a timestamp. They show what *kind* of thread each one is, never what *happened*. For an agent whose record is the product ("Done, then shown"), the drawer is the obvious place to show state: "통화 끝 · 0:42", "승인 대기", "요약을 만들었어요". Right now it lists containers. The `sparkles` glyph on "이사 준비" is the one AI-cliché DESIGN.md names explicitly.

**Deterministic scan.** Pending: Assessment B, joined by design-director.

## Overall Impression
A tidy, native-feeling drawer with the right information architecture. The weakest part is the content of each row: the type is drawn twice (glyph tile and subtitle), state is mostly missing, and the meeting thread wears the wrong icon. The biggest opportunity is cheap: let each row say what the agent did or is waiting on, and drop the plates.

## What's Working
- **Conversation-first IA.** Search → 기본 채팅 / 친구 → 추가 대화 → one compact destination row (`DrawerContent.tsx:89-190`). The tab bar's job isn't duplicated, and friends (not in the tab bar) get a top-level slot. That's MOTION-SPEC §8.10 as written.
- **Search that understands Korean.** 초성 matching, IME-safe Enter, a live region announcing "N개 결과" after 400 ms, and the tabs and list hidden while searching (`ui/Spotlight.tsx:101-112`). In `21` the query "ㅎㅇ" finds "회의 참여" in one step.
- **Row mechanics are right.** Titles ellipsize on one line, times are tabular and top-aligned, the unread dot has `aria-label="읽지 않음"`, the open thread carries `aria-current="page"`, and every target is ≥ 44 px (rows 56 px, archive 44 px).

## Priority Issues

**[P2] Rows say what kind of thread it is, not what happened in it**
- **What:** Subtitles come from thread creation and never change. "깽이의 외부 통화" and "깽이의 회의 참여" are static strings set by the server. The meeting thread is titled just "회의 참여", so two meetings would look identical. The state badges ("승인 대기", "통화 중") are computed on the client by scanning `messagesStore`, so a thread whose messages haven't been loaded this session shows no badge even when an approval is waiting.
- **Why it matters:** The drawer is where a user comes back to after leaving the app mid-task (PRODUCT.md: "work must survive leaving the app"). Glanceable state is the job here. A pending call approval that doesn't surface after a cold start means the call silently never happens.
- **Fix:** (1) The server updates `thread.subtitle` on the events it already emits: for example "전화를 걸었어요 · 오후 3:12", "회의를 요약했어요", "체크리스트를 만들었어요" (already used for 이사 준비). (2) Title meeting threads with what the bot joined (meeting title, or "오후 3시 회의" when there's no title). (3) Add the pending state to the thread payload (for example `thread.waiting: "approval" | "call" | null`, set server-side), and render the existing `.dw-badge` from it instead of from loaded messages. Keep the badge style: inverted `--label` pill, icon + words.
- **Evidence:** `20-drawer` (all engines: "깽이의 외부 통화", "깽이의 회의 참여"). `DrawerContent.tsx:34-48` (badge derived from in-memory messages), `DrawerContent.tsx:161`, `DrawerContent.tsx:209-216`. `apps/server/src/phone.ts:197` and `apps/server/src/meet.ts:563` (static subtitles, generic "회의 참여" title).

**[P2] Wrong and clichéd glyphs, drawn on plates**
- **What:** Every row has a 32 px white rounded-square plate (`.dw-row-icon`, literal `r10`) holding a glyph picked by `KIND_ICON[thread.kind]`. Meetings are `kind: "call"`, so "회의 참여" gets the outgoing-call glyph even though the server sends `icon: "people"`. Tasks get `sparkles`. The archived-threads toggle in the section header uses the `archive` glyph, which is also the 보관함 (artifacts) icon in the destination row right below.
- **Why it matters:** DESIGN.md: "Icon tiles go… icons sit in flow at text size", and "Don't use `sparkles`… to signal AI". A user scanning for the meeting summary looks for something meeting-like and finds two identical phone icons. Two archive icons that do different things invite the wrong tap.
- **Fix:** Render `thread.icon` from the server, falling back to `KIND_ICON` (`DrawerContent.tsx:202`). Change `KIND_ICON.task` from `sparkles` to `doc`. Most task threads will show their template's own icon anyway, because the server sends it in `thread.icon`. Drop the plate: a 20 px glyph in `--label-2`, no background, aligned to the title's first line, with the same 12 px gap. For friend threads, show the friend agent's `Avatar` at 24 px, since that identifies a third party. Make the archive toggle a visible text button using the aria-labels it already has: "보관한 대화" / "추가 대화" (`--t-footnote` 600, `--label-2`, 44 px hit), and drop the glyph.
- **Evidence:** `20-drawer` ("회의 참여" and "연세바른치과께 전화" share the phone-out glyph; "이사 준비" shows sparkles; archive glyph at the section head and in the bottom row). `DrawerContent.tsx:148-150`, `:201-203`. `screens/chat/util.ts:78-84`. `drawer.css:141-150`. `apps/server/src/meet.ts:563` (`icon: "people"`).

**[P2] Opening search empties the drawer until you type**
- **What:** Tapping "대화 검색" hides 기본 채팅, 친구, the thread list and the destination row (`!searching && …`). With an empty query, Spotlight renders nothing below the bar. `Spotlight` supports a `recent` list for exactly this, but the drawer doesn't pass one.
- **Why it matters:** A blank pane after a tap feels broken (Jordan), and it removes recognition: the user has to recall a title to type instead of picking from what was just there. Casey, one-handed, then has to type for something that was visible a second ago.
- **Fix:** Pass `recent={extra.slice(0, 5)}` to the drawer's `Spotlight` (`DrawerContent.tsx:94-107`) so the empty query shows the latest threads under "최근". Set the list's aria-label for the empty query to "최근 대화" instead of "최근 검색" (`ui/Spotlight.tsx:282`), since these are threads, not past searches.
- **Evidence:** `21-drawer-search` (only the typed state was captured; the empty state was read from source). `DrawerContent.tsx:92-120`. `ui/Spotlight.tsx:30-31` (`recent` prop), `:281-282`.

**[P2] The top search result is a solid blue slab with low-contrast text**
- **What:** The first match is always "selected": a full `--accent` fill with white label, 85 %-white subtitle at 13 px (≈ 3:1 on #0A84FF; the label is ≈ 3.6:1), and the match highlight `<mark>` switched off on that row. On a phone, with no arrow-key cursor, the slab doesn't mean "selected". It looks like a pressed button.
- **Why it matters:** WCAG AA needs 4.5:1 for 13–17 px text (PRODUCT.md: "WCAG AA: 4.5:1 body"). The only result usually shown is exactly the row that hides why it matched. The blue block is also the loudest thing in the drawer, while One Voice reserves accent for the primary action and on-states.
- **Fix:** On coarse pointers (`@media (pointer: coarse)`), render the active row as `--fill` with `--label` text and keep `mark` in `--accent-text` 600. Keep the accent slab for fine pointers and keyboard focus, where it is a real cursor and MOTION-SPEC §3's Spotlight behaviour applies. In both cases the subtitle must reach ≥ 4.5:1: on accent use full `--on-accent` at `--t-subhead`, or drop the subtitle on the active row.
- **Evidence:** `21-drawer-search` (all engines). `ui/Spotlight.css:169-172`, `:201-203`, `:212-214`.

## Cognitive Load
- Checklist failures: **2 of 8** (moderate).
  - *Working memory:* "회의 참여" with subtitle "깽이의 회의 참여" makes the user remember which meeting it was. Search with an empty query makes them recall a title (no recents).
  - *Visual hierarchy* (search state): the solid accent result outweighs the query field and the title. Everything else in the drawer has clean weights.
- Decision points with > 4 visible options: the drawer at rest shows 12 targets (search, 2 nav, archive toggle, 5 threads, 3 destinations). They're chunked into four clearly separated groups, so this is acceptable for a navigation surface. The thread list itself (5) is a list, not a choice set.

## Emotional Journey
- **Open:** calm. The agent's face and name sit at the top, and the list is short and legible.
- **Scan:** a small dip. "Which one is my dentist call, did it go through?" gets no answer from the rows; the user has to open the thread.
- **Search:** a quick win with 초성 ("ㅎㅇ" works). The blank pane before typing and the shouting blue result row take some of the delight away.
- **Return to a waiting task:** the high-stakes moment. If an approval is pending and its badge doesn't show (cold start), the user doesn't know the agent is waiting on them. Reassurance is missing exactly where it matters.

## Persona Red Flags
**Alex (power user):** 초성 and arrows + Enter are there, which is good. Red flags: ⌘K on desktop (MOTION-SPEC §3) does nothing; no way to search inside thread content (titles, subtitles and peer names only); no swipe actions on rows (archive or pin) like iOS Mail; the archive toggle hides behind an unlabeled icon.

**Sam (screen reader / low vision):** the drawer gets `inert`/`aria-hidden` when closed and focus moves to the first button on open, which is good. Red flags: the 13 px subtitle on the accent result is ≈ 3:1; the archive toggle is announced only through `aria-pressed` + label, with no visible text for low-vision users; the meeting row's glyph says "phone call".

**Casey (one-handed):** the drawer opens by edge-swipe, which is good. The destination row sits mid-height (`margin-top: auto` doesn't pin it, because the column has no definite height), so its position shifts as threads are added. Search's 취소 is top-right, the hardest reach with the left-edge drawer open. That's acceptable because the clear-× and closing the drawer also work.

**Project persona: "지은", who left the app while 깽이 phones the clinic** (PRODUCT.md: short bursts, frequently interrupted, work must survive leaving). She reopens the app, opens the drawer and wants to know whether the call happened. Red flags: the row says "깽이의 외부 통화" whether it's pending, done or failed; "승인 대기" may not show after a cold start; the dentist row and the meeting row look identical.

## Minor Observations
- "나만의 AI 에이전트" under the agent name (`app/Drawer.tsx:84`) is jargon and filler. Remove the line and vertically centre the name, or show something true and useful (the user's handle).
- Literal radii throughout (`.dw-item` / `.dw-row` 14 px, `.dw-row-icon` 10 px, `.dw-badge` 9 px; `drawer.css:55`, `:130`, `:147`, `:199`). Map them to tokens (`--r-field` 14 is fine by name; badge → `height / 2`).
- The Spotlight bar is glass (`Glass text radius={26}`) over the drawer's opaque `--surface-2` paper. There's nothing behind it to refract, so it reads as a white capsule with a shadow. A plain `--surface` field would be honest. This isn't a glass-count issue, because the drawer itself isn't glass.
- The search results panel (`.spot-results`) uses the two-layer paper shadow. As a floating popover that's defensible, but in dark mode it already relies on a hairline; light could do the same.
- The empty search text "찾는 대화가 없어요" could add the next step: "다른 글자나 초성으로 찾아보세요".
- Thread titles mix "…께 전화" (person honorific on a clinic; see phone-delegation.md) with the friend thread "깽이와 진우님의 모시". The josa fix belongs to the server title templates.

## Engine and Theme Differences
- Chromium and WebKit render identically: same row metrics, same Spotlight glass and result card. Thread order differs between captures (friend first in chromium-light, call first elsewhere) because of fixture timing ("1분 전" vs "2분 전"), not a bug.
- Dark: plates become `#1c1c1e` tiles on `#2c2c2e`, which is quieter than light's white plates. The accent result row is identical in both themes, so the contrast issue holds in dark too. The dark Spotlight bar shows a visible rim (expected).

## Questions to Consider
- What if the subtitle were the agent's last sentence in that thread, the way Messages shows the last message? Would the drawer then be the "record" PRODUCT.md asks for?
- Should threads waiting on the user (approval, credential) pin to the top with the badge, even when they're older? The sort already does this for loaded threads; should the server own it?
- Does "추가 대화" still earn its name once the rows carry state? Would "맡긴 일" match how users think about these threads?
- Does the drawer need the agent's face at all, given the top bar already shows it? Could that space hold the one thing waiting on the user?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 20, 21.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `low-contrast` | 2 | 20, 21 | 3.0:1 (need 4.5:1) — text #daedff on #0a84ff; 4.0:1 (need 4.5:1) — text #6e6e73 on #e3e3e9 | **True positive.** Use `label` on fills (see the snippet). |
| `organic-clip-path` | 2 | 20, 21 | clip-path: path() with 12 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |
| `low-contrast` | 2 | 20, 21 | pixel contrast 2.3:1 median 2.3:1 (need 4.5:1) on unread layer "채팅" | **False positive (transient).** The tab label is under the drawer scrim, which is inert while the drawer is open. |
| `low-contrast` | 1 | 21 | 3.6:1 (need 4.5:1) — text #ffffff on #0a84ff | **True positive.** Every primary button fails: white on `#0A84FF` is 3.6:1 against the 4.5:1 needed at 17 px semibold. Fix it at token level: the button fill becomes the existing `--accent-text` `#0071E3`, which gives 4.7:1 (slop-inventory §2). |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** the Spotlight top result's subtitle (A about 3:1; B `#daedff` on accent, 3.0:1).
- **B caught, A missed:** **[P2]** the search field's placeholder row is 4.0:1. **[P1]** white on accent (3.6:1) on the solid top result.
- **A caught, B missed:** static type labels instead of state; the 승인 대기 badge depends on cached messages; wrong glyphs (the meeting row shows a phone, tasks use sparkles); search shows an empty list until you type.
- **False positives:** the tab label at 2.3:1 under the scrim (transient); `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- Assessment A only, isolated: I didn't read the slop inventory, any detector JSON or other critique files, and I didn't run the detector.
- Looked at: `20` and `21` in chromium-light, chromium-dark, webkit-light and webkit-dark. Source: `app/{Drawer.tsx,Drawer.css}`, `screens/chat/{DrawerContent.tsx,drawer.css,util.ts}`, `ui/{Spotlight.tsx,Spotlight.css}`, `apps/server/src/{phone.ts,meet.ts}` (thread titles, subtitles, icons), `packages/protocol` (`Thread`).
- Limits: stills only. The drawer camera move, the row spring-in and the Spotlight glyph rise were not judged. The empty-query search state and the badge behaviour after a cold start were read from source, not captured. Thread contents and timings are fixture data. The main card behind the drawer and the wallpaper were not critiqued.
- Rule names quoted from impeccable (Apache-2.0, © Paul Bakaus): heuristics guide, persona set, cognitive-load checklist.
