# 빈 대화와 제안: drafts A and B

Critique: `../../impeccable/critique/empty-thread.md` (27/40, Acceptable, P1 ×2). Inventory items: IT-1, IT-2, CH-1,
CH-2, NC-1, CP-1, CP-5, CP-8, GL-1, SH-1, RD-1.

There are three states per variant:
- **Empty thread** (`A.html`, `B.html`), the primary state, compared with 현재 `07-chat-empty-thread`.
- **First-run welcome** (`A-welcome.html`, `B-welcome.html`), compared with 현재 `05-chat-welcome`.
- **Briefing card after the first pick** (`A-briefing.html`, `B-briefing.html`), compared with 현재
  `06-chat-welcome-briefing`. The old 06 was the same frame as 05, because the welcome already sits at the list's end
  and a scroll could not move it. 06 is now captured right after tapping "오늘 날씨 알려줘". In the app that tap
  disables the other two send chips (`InfoCards.tsx:58`); the send is held in the browser, so no request is made.

Both variants share the chrome. There are 3 glass shapes: the menu circle, the composer and the tab bar. The agent's
name is plain text on the edge, with no capsule. 초대 moves out of the chat top bar into the drawer and 친구. Paper is
flat, and radii come from tokens only.

## Already fixed at HEAD (b3c2629)

현재 is captured from HEAD b3c2629, frozen for the drafts commit. Items HEAD already shows fixed are no longer chips;
the rule is the same in every feature.
- **SH-1 (fixed, chip removed):** no drop shadow is left on the empty-thread plate, the bubbles or the cards. Chat and
  card CSS carry only hairlines (dark, more contrast). My bubble is a flat `#dfdfe1` grey (1.21:1 on the paper). Seen on
  06 and 07.
- **RD-1 (fixed in this screen, chip removed):** the chat radii are tokens. The plate is `--r-tile` (12), bubbles are
  `--r-group`. The two 6 px radii left are glyph-sized (checkbox, inline code), not surfaces.
- **IT-2 and critique P2-1 (partly, chips kept):** the plate lost its shadow and its 18 px radius, but the 56 px
  `--surface` plate and the sparkles glyph stay until the empty-thread pick replaces them.
- **Still open, chips kept:** the first run opens mid-sentence (P1-1), the rows and chips repeat (P1-2, CH-1, IT-1), the
  one-shot menu (P2-2), the three stacked pills (CH-2), sparkles (CP-8), the encryption line (CP-1, CP-5) and the glass
  count (GL-1).

## A: the incumbent, minus the slop (conservative)

**Empty thread (`A.html`)**
1. 깽이 replaces the sparkles tile: a 56 px avatar that does not move. The name the headline calls out is now on screen
   (IT-2, CP-8).
2. The title and body copy are unchanged. Function and tone stay; this is a refinement.
3. The three grey pills stacked in the centre become one left-aligned grouped list. Chips are kept only for real
   choices (CH-2).
4. Tapping a suggestion fills the composer instead of sending it, so it can be edited first (MOTION-SPEC §6 #14).
5. Paper is flat and the list uses `--r-group`. HEAD b3c2629 already dropped the shadow and the 18 px radius (SH-1,
   RD-1), so those are no longer chips here.

**Welcome (`A-welcome.html`)**
1. The greeting is cut to two lines. The list shows what the agent can do; the encryption note appears only where a
   password is typed (CP-1, CP-5).
2. The four rows of "이런 일을 맡겨 보세요" are now the buttons. The four chips that repeated them are gone
   (CH-1, IT-1).
3. The icon plates are gone. Text-size glyphs remain in `label-2`, and `coins` (which reads as a database) is replaced by
   a document glyph.
4. The first run fits on one screen, and the greeting is the first thing you see (critique P1-1).
5. Glass is limited to the menu, the composer and the tab bar, on flat paper (GL-1, RH-3).

**Briefing card after the first pick (`A-briefing.html`)**
1. Tapping the weather row sends "오늘 날씨 알려 줘" at once, as it does today. The bubble appears in the same frame,
   and the assistant's paper shows "생각하는 중 · 2초" (the app's wait line).
2. The other three rows stay live. Asking about the weather doesn't lock the 지원사업 search (critique P2-2). A row
   tapped while the turn runs is steered into it, as the composer's messages already are.
3. Only the picked row rests in `label-2` until its answer lands, so it can't be sent twice. It is not the grey
   disabled state, and it is live again after the answer.
4. The composer's mic slot becomes the stop control while the turn runs (`ui/SendButton.tsx`).

## B: more distilled (bolder)

**Empty thread (`B.html`)**
1. Nothing sits at the top: just the calm wallpaper and the name in the bar.
2. The starters sit right above the composer, within thumb reach, next to where you speak.
3. The title is dropped and only the body line stays. The name is already in the bar, so "깽이가 기다리고 있어요" would
   repeat it (RH-1).
4. The suggestions have no paper and no chips, only hairline separators. A tap fills the composer (§6 #14).
5. When the keyboard rises, the starters lift with the composer (`visualViewport`, as the app works today), so they
   stay visible.

**Welcome (`B-welcome.html`)**
1. The bubble is gone. The agent's words are text on the canvas, and the only paper on screen is the task list (NC-1).
   **This changes MOTION-SPEC §6 #2 ("assistant text on paper cards"), so it needs approval.**
2. The first line of the greeting is set at title size, so it is clear where to start reading. The list has no title;
   the greeting's last sentence leads into it.
3. The rows have no glyphs and no plates. Only the KakaoTalk row, which leaves the screen, carries a chevron.
4. Each thing is said once: 8 items on the first screen (4 rows plus 4 chips) become 4. **The row copy is rewritten as
   "~하기" actions; the meaning is the same, the wording is new.**
5. The chrome is the same as A.

**Briefing card after the first pick (`B-briefing.html`)**
1. B's welcome carries on: the greeting is text on the canvas, and the task list is the only paper (NC-1).
2. The agent's turn has no bubble: the avatar and one status line, in the place of chat B's "N단계 · 시간" line. The
   answer follows below it as text.
3. Rows behave as in A: the picked row rests in `label-2` until its answer lands, and the others stay live.

## Motion kept (both)

- Suggestions enter on the `snap` spring, y 4 → 0, opacity 0 → 1, 30 ms apart. This matches `EmptyThread.tsx` today,
  on first mount only, with no re-entrance on return (the user's rule).
- Rows respond with the `press` spring: scale 0.97 plus a `--fill` tint (§3).
- A tap uses the existing focus request (`composerStore.focusSeq`), and the composer grows on `morph` (§6 #2).
- The avatar stays still at idle and breathes only after recent input (§8.11).
- The KakaoTalk row pushes Connections with the existing navigation.
- After a pick, the wait line appears after 1 s and swaps its status with `ContentSwap`. Mic and stop morph inside
  SendButton (§8.4). In B the avatar breathes while the agent works (§8.11). Nothing re-enters.

## A vs B

| | A | B |
| --- | --- | --- |
| Risk | Low: the layout is the same, only the slop is removed. | Medium: the welcome drops the assistant bubble (spec change), and B rewrites the row copy. |
| First screen | The agent is visible (the avatar is the hero). | The canvas stays calm and the action lives at the thumb. |
| Glass / paper | 3 glass shapes / 1 paper group | 3 glass shapes / 1 paper group on the welcome, none on the empty thread |
| Fixes | P1-1, P1-2, P2-1, P2-2, P2-3 | Same as A, plus RH-1 |

**Recommendation: A** for the next build. It fixes every P1 and P2 with no spec change. B's empty thread (the starters
at the composer) can follow later as an experiment on its own.

## Files

- Captures, JPEG q82: `A-light.jpg`, `A-dark.jpg`, `B-light.jpg`, `B-dark.jpg`, `A-welcome-*.jpg`, `B-welcome-*.jpg`,
  `A-briefing-*.jpg`, `B-briefing-*.jpg`.
- PNG copies are in `png/`. Re-render with `node docs/design/drafts/_kit/render.mjs empty-thread`.
