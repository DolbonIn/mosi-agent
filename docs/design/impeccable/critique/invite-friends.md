Method: dual-agent (A: critique-a4 · B: impeccable detector over CDP, run by design-director)

# Critique: 친구 초대 (Friends and invites)

2026-11-12 · Mode: Operate · Screens: `44-friends`, `45-invite-sheet` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | "링크를 만드는 중이에요" while the link is minted, then expiry and one-time use, then a check plus an island banner on copy, and "○○ 님과 친구가 됐어요" after adding. Gap: the chat-tab sheet says neither "one time" nor "copied" beyond its button. |
| 2 | Match Between System and Real World | 3 | A new concept (a friend's agent) said plainly: "콩이와 함께 · 2분 전부터". Leaks: the placeholder `https://…/i/…`, a host-plus-token string shown as the link, and the @-mention mechanic explained inside a privacy note. |
| 3 | User Control and Freedom | 3 | × and drag-to-dismiss. 차단하기 and 친구 끊기 are two-step with the consequence written above each. 차단 풀기 exists. |
| 4 | Consistency and Standards | 2 | The same "초대" capsule opens two different sheets (chat vs friends and explore), and `.invite-link` is defined globally in two stylesheets. A decorative chat glyph on the row is styled like a button. |
| 5 | Error Prevention | 3 | The link parser accepts a full URL, `?invite=` or a bare token. 추가 stays disabled until there is text. The friends sheet states expiry and one-time use up front. |
| 6 | Recognition Rather Than Recall | 3 | The friend's agent name and the friendship age are on the row. Management sits behind a conventional "…". |
| 7 | Flexibility and Efficiency of Use | 3 | System share sheet, copy, paste-to-add, Enter submits, and an `/?invite=` deep link that offers acceptance on arrival. |
| 8 | Aesthetic and Minimalist Design | 2 | Four glass shapes on screen. A recessed link panel with an icon tile. The same privacy sentence twice when the sheet is open. The page opens on a two-idea paragraph. |
| 9 | Help Users Recognize, Diagnose, and Recover from Errors | 3 | "초대 링크를 확인해 주세요. 친구가 보낸 링크를 그대로 붙여 넣으면 돼요." keeps the pasted text. A failed link offers "다시 만들기". The chat sheet has no retry. |
| 10 | Help and Documentation | 3 | The sheet's lead says what the link does, the empty state says why to invite, and a one-tap 설정 보기 jumps to the scope settings. |
| | **Total** | **28/40** | **Good** |

## Design Specificity Verdict
**LLM assessment.** The concept is specific and the execution is generic. The idea that each friend comes with their own agent, and that the two agents can talk, is unique to 모시. It surfaces well in one place: the row subtitle "콩이와 함께", where the friend's agent appears as a blob. The invite sheet itself (a link box, copy and share buttons, a fine-print line) is the share-link pattern every app uses. That is acceptable on an Operate surface, but it misses the chance to show the one thing that makes this invite different: what the friend's agent will and won't see. The sheet only links to it. The structural weakness is that the feature exists twice, with two different voices (see P1).

**Deterministic scan.** See Assessment B below.

## Overall Impression
The friends screen is small, calm and mostly right: one list, one add field, consequences spelled out in the manage sheet. The problems are duplication and chrome. There are two invite sheets that promise different things, the privacy line appears twice, and a fourth glass shape sits in the top bar. The single biggest win is to make "초대" mean exactly one sheet everywhere, and then remove what repeats.

## What's Working
1. **Destructive actions are explained before they happen.** "차단하면 함께 쓰던 대화방이 숨겨지고, 서로의 모시에게 말을 전할 수 없어요. 상대에게 알리지 않아요." Each sentence sits above a two-step ConfirmButton (FriendsScreen.tsx:179-189). This is the brand's "says what it will do" voice applied exactly where it matters.
2. **Add-by-link is forgiving.** The parser takes any reasonable form (FriendsScreen.tsx:198-203). The error tells the person what to do, keeps their text, and Enter submits (FriendsScreen.tsx:209-228).
3. **Copy is confirmed only after it really happened.** The check draws once the clipboard accepted the link, followed by an island banner "초대 링크를 복사했어요 · 친구에게 보내 주세요" (InviteSheet.tsx:40-44). This follows MOTION-SPEC "never claims success before the server does".

## Priority Issues

**[P1] One "초대" capsule, two different invite sheets**
- **What:** Explore and 친구 call `presentInvite` (InviteSheet.tsx). The chat tab calls its own `openInvite` with a separate `InviteBody` (ChatScreens.tsx:123-181). The two disagree on almost everything:

  | | Chat sheet | Friends and explore sheet |
  |---|---|---|
  | Lead copy | "링크를 받은 친구가 모시를 시작하면 바로 친구가 되고…" | "친구가 이 링크를 열면 바로 모시 친구가 돼요…" |
  | Expiry and use | "…까지 쓸 수 있어요" (never says one-time) | "23시간 59분 뒤까지 · 한 번만 쓸 수 있어요" |
  | Buttons | 링크 복사 is blue primary | both neutral |
  | Share label | "공유" | "공유하기" |
  | Privacy icon | shield | lock |
  | URL | full URL with scheme, in monospace | URL without scheme |
  | After copy | no island banner | island banner |
  | On error | no retry | 다시 만들기 |
  | Scope link | no 설정 보기 | 설정 보기 |

  Both style a `.invite-link` class that is defined globally in chat.css:876 and friends.css:4, so whichever stylesheet loads last also restyles the other sheet.
- **Why it matters:** The same button in the same top-bar position makes different promises. A person who invites from chat and pastes the link into a group chat is never told it works only once. The second friend's tap fails, and that is a support message.
- **Fix:**
  - In ChatScreens.tsx:25, call `presentInvite(el)` from `screens/more/friends/InviteSheet`.
  - Delete the chat `InviteBody`, `openInvite` and their CSS (chat.css `.invite*`).
  - In InviteSheet give exactly one primary. When `navigator.share` exists, `공유하기` is `tone="primary" size="lg" fullWidth` and `링크 복사` is `tone="secondary"`. Otherwise `링크 복사` is the primary.
- **Evidence:** `45-invite-sheet` (the friends version). ChatScreens.tsx:25, 123-181; InviteSheet.tsx:19-103; ExploreScreen.tsx:34; FriendsScreen.tsx:33; chat.css:861-895; friends.css:4-44.

**[P2] Four glass shapes on 친구, and an invite capsule on a screen with no social task**
- **What:** 친구 shows a back circle, the agent capsule, a "초대" capsule and the tab bar: four glass shapes. Explore also mounts "초대" in its top bar, though nothing on Explore is social.
- **Why it matters:** "≤3 glass elements visible" is a binding platform constraint (PRODUCT.md) and the Two-Layer Rule (DESIGN.md). The top-right corner is also the hardest spot to reach one-handed.
- **Fix:**
  - On 친구, drop `useTopBarRight` (FriendsScreen.tsx:33).
  - Under the friend list, render `친구 초대하기` as a full-width neutral button: `tone="secondary" size="lg" icon="link"`, neutral per the One Voice Rule. It is the sheet's source, so the sheet still grows out of it.
  - The empty state keeps its primary "친구 초대하기", because it is that state's only action (MOTION-SPEC §8.14).
  - On Explore, remove the capsule (ExploreScreen.tsx:34). Invite stays reachable from chat, from the drawer's 친구 entry, and from 나의 모시 › 친구.
  - The chat top bar is the top-bar owner's draft decision (DESIGN.md "Glass count").
- **Evidence:** `44-friends` (all four captures). FriendsScreen.tsx:33, 69-83; ExploreScreen.tsx:34.

**[P2] The privacy sentence twice at once, and a page note that carries two ideas**
- **What:** The page opens on "친구의 모시는 정보 공개 범위에서 허락한 것만 볼 수 있어요. 메시지에 모시 이름을 부르거나 @로 시작하면 내 모시가 대신 답해요." The invite sheet repeats "친구의 모시에게는 정보 공개 범위에서 허락한 것만 보여요". With the sheet open, both are on screen.
- **Why it matters:** "Say it once" (DESIGN.md) and Product Principle 3 ("plainly, once, where it matters"). The mention mechanic is a how-to that has nothing to do with privacy, but it is buried in a lock-icon note, so nobody reads it as a how-to.
- **Fix:**
  - Keep the privacy line only in the sheet, where the decision to share happens, together with its `설정 보기` link.
  - Rewrite the page note as the how-to alone, with no icon: `메시지에서 모시 이름을 부르거나 @로 시작하면 내 모시가 대신 답해요.`
- **Evidence:** `44-friends`, `45-invite-sheet`. FriendsScreen.tsx:45; InviteSheet.tsx:88-100.

**[P2] The friend row's chat glyph looks like a second button**
- **What:** The row ends with a chat-bubble glyph and then a "…" button, two equal-weight trailing icons. The bubble is decoration inside the row button (`aria-hidden`, `.friend-chev`). Only "…" is a separate control.
- **Why it matters:** Two trailing icons read as two actions. People will aim for the bubble, a small target that looks like its own button, when the whole row already opens the shared conversation. It is a false affordance next to a real one.
- **Fix:**
  - Replace the bubble with the standard chevron used by ListRow (`chevron-right`, 16 px semibold, `--label-3`) so the row reads as "opens".
  - Keep the "…" button at 48×64.
- **Evidence:** `44-friends`. FriendsScreen.tsx:117-125; friends.css:117-128.

**[P3] The link is shown as a recessed panel with an icon tile and a raw token**
- **What:** The sheet nests a `--surface-2` panel (r18) holding a 34 px r10 link tile and the string `127.0.0.1:8743/i/ZmD-DYzUldW…`. The host is fixture data; the token string ships to production.
- **Why it matters:** This is DESIGN.md's "no recessed panel", "no icon tile" and Token Radius rules. A machine string is also the most prominent text at the moment of sharing, and the person never needs to read it.
- **Fix:**
  - Drop `.invite-link` and `.invite-link__icon`.
  - Under the lead, show one footnote line in `--label-2`, tabular-nums: `23시간 59분 뒤까지 · 한 번만 쓸 수 있어요`.
  - Keep the URL as a second footnote line with ellipsis if the team wants it visible, in plain text, with no panel and no tile.
- **Evidence:** `45-invite-sheet`. InviteSheet.tsx:58-68; friends.css:4-44.

## Cognitive Load
Checklist failures: 2 of 8 (moderate, low end).
- **Grouping:** the two halves of one task, sending an invite (a top-right capsule) and accepting one (an in-content field), sit at opposite ends of the screen with different weights.
- **Visual hierarchy:** the first content is a three-line footnote paragraph. When the person has friends, there is no in-content primary, so the page's main action lives only in the corner.

No decision point shows more than 4 options. The friend row has two trailing targets.

## Emotional Journey
- **Stakes:** inviting is social and slightly risky, because the person wonders what the friend's agent will be able to see. The sheet answers that at the right moment, with the lock line and 설정 보기, but the same line on the page underneath dilutes it.
- **Peak:** the friend row's "콩이와 함께". The other person's agent has a name and a face, which makes the social idea concrete.
- **Valley:** the most prominent text at the moment of sharing is a host-and-token string.
- **End:** copying ends well on the island banner "친구에게 보내 주세요", but only from 친구 and Explore. From chat the sheet just sits there with a check.

## Persona Red Flags
**Jordan (first-timer):**
- There are two ways in: "초대" at top right and "받은 초대 링크로 친구 추가" in content. Jordan has to work out which one is for them.
- The bubble glyph on the row looks tappable on its own and does the same thing as the row.
- The @-mention feature is explained inside a privacy note, so Jordan never connects it to "how do I talk to my friend's agent".

**Casey (one hand, interrupted):**
- 초대 is in the top-right corner, the farthest point from the thumb. With one or more friends there is no reachable alternative.
- To add a friend, Casey leaves for the messenger, copies, and comes back. The field's placeholder `https://…/i/…` doesn't say "paste here".

**Riley (stress tester):**
- From chat, Riley shares the link to a group chat. Nothing on that sheet says one-time, so the second friend fails.
- Each sheet open mints a fresh link (`useEffect` → `createInvite`, InviteSheet.tsx:36-38). Whether earlier links stay valid is never stated.
- Riley pastes junk and gets a good error.

**Project persona, "the sharing pair, 민호 and 수아"** (from PRODUCT.md: share a conversation with a friend and both agents):
- They get two different explanations of what happens next: "함께 있는 대화가 열려요" vs "함께 쓰는 대화방이 생겨요".
- What 수아's agent can see of 민호 is one tap away (good), but only from one of the two sheets.

## Minor Observations
- **Add-by-link field:**
  - The placeholder `https://…/i/…` could be `받은 링크를 붙여 넣어 주세요`.
  - The 추가 button is aligned to the 52 px field with a computed `margin-top` (friends.css:156-159). It works at 100 % text size; check it at 130 %.
- **Empty state:** it uses the shared 64 px circle plate for its glyph (ui/EmptyState.css:10-19). This is cross-referenced in the settings critique and should go with the plates.
- **People as blobs:** the friend row shows the friend as their agent's blob. That is consistent with the product idea, but it is the one place a person, not an agent, is represented by a character.
- **Not captured:** the manage sheet (FriendsScreen.tsx:134-195) stacks three groups, each a note plus a full-width ConfirmButton. It is clear and was judged from source only.

## Engine and Theme Differences
- **WebKit:** wraps the page note and the sheet's lead at a shorter measure than Chrome (three ragged lines vs fuller lines). Nothing clips.
- **Dark:**
  - The disabled 추가 nearly disappears (`--fill` on near-black).
  - The top-bar avatar sits on a bright white disc.
  - The plain text field reads correctly with its hairline.
- **Both engines:** the 초대 capsule is hidden while the sheet is open, because it is the sheet's source. That is correct per MOTION-SPEC.

## Questions to Consider
- What if the invite sheet showed what the friend's agent will see (the three scope lines as plain text), instead of only linking to the setting?
- Does Explore need an invite entry at all, or is invite a chat and friends affordance only?
- Should opening the sheet twice mint two live one-time links, or reuse the unexpired one?
- If people appear as their agent's blob, should the row say whose agent it is ("진우 님의 콩이")?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 44, 45.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `low-contrast` | 2 | 44, 45 | placeholder 2.0:1 (need 4.5:1) — text #b9b9bb on #ffffff | **Minor.** Every field has a visible label, so this is not blocking. Raise placeholders to about 3:1 (`#8e8e93`). |
| `skipped-heading` | 4 | 44, 45 | <h1> "보관함" followed by <h3> "11월 12일 주간회의 회의록" (missing h2); <h1> "친구" followed by <h3> "친구 1명" (missing h2) | **True positive.** `SectionLabel` renders `<h3>` straight after the page `<h1>` (`screens/more/parts.tsx:93`), so VoiceOver's heading rotor skips a level. Make it `h2`. |
| `organic-clip-path` | 2 | 44, 45 | clip-path: path() with 16 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** A's placeholder note matches B's 2.0:1 placeholder on the invite-link field.
- **B caught, A missed:** **[P2]** heading skip `<h1>` 친구 → `<h3>` 친구 1명.
- **A caught, B missed:** the same 초대 capsule opening two different sheets; four glass shapes; the privacy sentence repeated; the row's chat glyph reading as a second button.
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- **Looked at:** `44-friends` and `45-invite-sheet` in chromium-light, chromium-dark, webkit-light and webkit-dark. The chat welcome capture `05-chat-welcome` was checked once only, to confirm the chat top bar's "초대" capsule.
- **Source:** FriendsScreen.tsx, InviteSheet.tsx, friends.css, ChatScreens.tsx:1-181 (top bar and the chat invite sheet), ExploreScreen.tsx:20-50, app/topBarStore.ts, chat.css:861-895, ui/TextField.{tsx,css}, ui/EmptyState.css.
- **Limits:**
  - Stills only, so there are no motion findings.
  - Fixture data: one accepted friend, and the invite host is `127.0.0.1:8743`.
  - The chat-tab invite sheet, the empty state, pending and blocked groups, and the manage sheet were not captured and are judged from source.
  - The background was not critiqued.
- **Isolation:** the detector was not run, and no other critique or detector output was read.
- **Method:** impeccable `critique` (Assessment A), `craft-floor`, `ios` and `mode-operate` references. Impeccable is Apache-2.0, © Paul Bakaus. Rule names are quoted only.
