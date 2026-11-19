Method: dual-agent (A: critique-a2 · B: impeccable detector over CDP, run by design-director)

# Critique: 온보딩 (Onboarding)

2026-11-12 · Mode: Persuade · Screens: `01-onboarding`, `02-signup-step1`, `03-signup-step2`, `04-login-sheet` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Step counter `1/2`, busy labels ("모시를 만드는 중") and the server-gated loader → check are all present. The one gap: nothing says the red character on screen is a stand-in. |
| 2 | Match Between System and Real World | 3 | Warm 해요체. The handle rule "영어 소문자, 숫자, _ 3~20자" reads as software-speak to a non-technical user. |
| 3 | User Control and Freedom | 3 | × close, drag-dismiss and a way back to step 1. Field state survives closing and reopening the sheet, because the sheets stay mounted. You can't switch from 로그인 to 시작하기 inside the sheet. |
| 4 | Consistency and Standards | 3 | The step-2 back control sits in the form body, not in the sheet header's empty left slot. The sheet height jumps between steps. |
| 5 | Error Prevention | 3 | Hints show before typing, plus `maxLength`, lowercase coercion and a password reveal. The CTA is live while fields are empty, so validation only runs when it's pressed. That's acceptable. |
| 6 | Recognition Rather Than Recall | 3 | Suggested names, persistent hints and correct `autoComplete` tokens for password managers. |
| 7 | Flexibility and Efficiency of Use | n/a | Persuade surface: a one-time entry flow (the method allows n/a here). Password-manager autofill is wired anyway. |
| 8 | Aesthetic and Minimalist Design | 3 | Calm, one accent, clear hierarchy. The hero is the category template, and step 2 says "깽이" twice (field and selected chip). |
| 9 | Help Users Recognize, Diagnose, and Recover from Errors | 2 | Server errors land at the right field and route back to step 1. Login has no recovery path at all: a user who forgot the password can only press "다시 로그인". |
| 10 | Help and Documentation | n/a | Persuade surface (the method allows n/a). |
| | **Total** | **23/32** | **Good (72 %)** |

## Design Specificity Verdict
**LLM assessment.** Specificity is split. The agent character is authored and belongs to this product: a soft 3D blob with eyes, the one expressive element the brief allows. It makes the first viewport feel like 모시. Everything around it is category-interchangeable: centred mascot, two-line headline, grey subtitle, a full-width blue capsule, and "이미 계정이 있어요 · 로그인" underneath. Swap the blob for a logo and any assistant app could ship this screen unchanged.

The Persuade bar asks the opening to "demonstrate something only this product can prove". The subtitle ("말로 맡기면 알아서 찾아보고, 정리하고, 대신 해 드려요.") doesn't do that. Phone calls in a Korean voice, KakaoTalk through your own account, Meet attendance and device-signed approvals are what only 모시 does, and none of them appear. The biggest missed opportunity is the character itself. It is a default red (hue 8) that the user never gets to keep: after sign-up the server assigns a different hue and eye style. So the most specific thing on screen is also the least honest.

**Deterministic scan.** Pending: Assessment B, joined by design-director.

## Overall Impression
A clean, quiet entry that does its job: one obvious action, a short two-step sheet, and server-confirmed success. It already looks like the "Quiet Concierge". Two things undercut it. The emotional peak (naming your agent) happens on a form while the character sits dimmed behind a scrim. And the character then changes colour when the chat opens. The biggest opportunity: make the blob you meet the blob you keep, and let the naming step look at it.

## What's Working
- **One action, truly primary.** "시작하기" is the only accent on the screen, and the secondary path is plain text with the action word in `--label` 600 (`onboarding.css:88-101`). That matches DESIGN.md's One Voice Rule exactly.
- **Honest async.** The CTA shows loader → check only after the server confirms (`Onboarding.tsx:172`, `:293`), with busy and success labels in plain 해요체 ("모시를 만드는 중", "만들었어요"). Errors from the server land at the field they belong to, and handle or password errors bounce back to step 1 (`Onboarding.tsx:142-148`). Permissions are not asked here (MOTION-SPEC §8.12).
- **Hangul-aware text.** The headline breaks cleanly at "나만의 모시를 / 만나보세요" (`max-width: 14ch`, `text-wrap: balance` from base.css), the subtitle at "찾아보고, / 정리하고". Both engines render identically.

## Priority Issues

**[P1] Login has no way back for a forgotten password**
- **What:** The login sheet has 아이디, 비밀번호 and 로그인. Nothing else: no "비밀번호를 잊었어요" and no link to sign up instead. On a wrong password the button just becomes "다시 로그인". The server has no reset route either.
- **Why it matters:** A returning user who forgot the password, or reinstalled the PWA, is stuck for good. That user writes to support (method rule: P1). It also contradicts "Calm by default": a dead end at the front door feels like being locked out of your own agent.
- **Fix:** Add a plain text button under the password field, styled like `.onb-back` (`--t-subhead`, `--label-2`, 44 px hit). Label it "비밀번호를 잊었어요". It opens a small sheet that tells the truth about recovery today. Until there is a backend path, the honest copy is "지금은 비밀번호를 되찾을 수 없어요. 새 아이디로 다시 시작해 주세요." with one neutral button "새로 시작하기" that swaps to the sign-up sheet. Add the mirror line under the login button too: "처음이에요 · 시작하기" (same treatment as `.onb-login`). This needs a product decision on real recovery. See Questions.
- **Evidence:** `04-login-sheet` (all engines). `Onboarding.tsx:258-329` (LoginSheet: no recovery or switch control), `Onboarding.tsx:293` (`errorLabel="다시 로그인"`). No reset route in `apps/server/src` (searched: reset, forgot, 잊).

**[P2] The character you meet is not the one you keep, and you name it without seeing it**
- **What:** Onboarding renders `AgentBlobLazy` with no spec, which falls back to `DEFAULT_AVATAR` (hue 8 red, oval eyes). At sign-up the server creates the agent with `hue = hash32(userId) % 360` and dot eyes. In these captures it's a green dot-eyed 깽이, as soon as the chat opens (`05-chat-welcome`). During step 2, where the user types "모시 이름", the blob sits greyed under the sheet scrim and only its top half shows.
- **Why it matters:** The headline promises "나만의 모시를 만나보세요". The peak-end moment is naming your agent, and the end is meeting it in chat, where it turns out to be a different creature. That breaks the one expressive element the brand owns ("The Agent Owns Its Colour").
- **Fix:** Pick the hue once, on the client, when Onboarding mounts (any 0–359), and pass `spec={{ hue, shape: "blob", eyes: "dot" }}` to `AgentBlobLazy` (`Onboarding.tsx:61`). Right after `signup()` resolves, PATCH that avatar through the existing profile route, which already accepts `avatar` (`apps/server/src/profile.ts:27-31`), so chat shows the same blob. In step 2, add a 40 px `Avatar` of that spec to the sheet title row, so the name is typed next to the face it belongs to: "깽이" beside a green dot. No new colour enters the UI: the hue stays inside the character, per DESIGN.md.
- **Evidence:** `01-onboarding` (red, oval eyes) vs `05-chat-welcome` / `08-…` / `20-drawer` (green, dot eyes). `03-signup-step2` (blob dimmed). `Onboarding.tsx:61`. `ui/Avatar.tsx:14` (`DEFAULT_AVATAR = { hue: 8, …, eyes: "oval" }`). `packages/launcher/src/launcher.ts:71-73` (server default `hash32(userId) % 360`, `eyes: "dot"`).

**[P2] The two sign-up steps don't share one frame**
- **What:** Step 1's sheet is shorter than step 2's, so the sheet changes height between steps. At step-1 height the sheet's top edge cuts straight through the headline: half-glyphs of "나만의 모시를" peek above the sheet. The way back from step 2 is a chevron text link, "아이디 다시 정하기", placed in the form body under the chips. Meanwhile the sheet header already has an empty 44 px left column.
- **Why it matters:** A height jump plus a sliced headline reads as a glitch at the moment trust is being formed. iOS users look for "back" at the top-left of a sheet, not under the inputs. The current label also undersells it: going back changes the password too, not only the handle.
- **Fix:** (1) Give both steps one body height: set `min-height` on `.onb-form` to step 2's content height (≈ 360 px at 390 wide), so the panel top lands above the title block on both steps and only the content swaps (ContentSwap stays). (2) Add an optional `leading` slot to `Sheet` (grid column 1 of `.sheet-head`) and, on step 2, put a chevron-left circle there, built like `.sheet-close-plate` (32 px `--fill`, 44 px hit), with `aria-label="이전 단계"`. Delete the `.onb-back` row.
- **Evidence:** `02-signup-step1` (headline sliced at the sheet edge, all four engine/theme captures) vs `03-signup-step2`. `Onboarding.tsx:179-253` (steps swap with no shared height), `Onboarding.tsx:247-250` and `onboarding.css:136-150` (back link in body), `ui/Sheet.css:24-33` (`grid-template-columns: 44px 1fr 44px`, left column unused), `ui/Sheet.tsx:46-63` (no leading prop).

**[P3] Handle rule written for developers**
- **What:** The hint "영어 소문자, 숫자, _ 3~20자" and the error "아이디는 영어 소문자, 숫자, _로 3~20자여야 해요" use a bare underscore glyph, written as a token list.
- **Why it matters:** PRODUCT.md's users are not technical. A literal-minded first-timer won't know that "_" means "밑줄 is allowed". It's small, but it's the first text field they meet.
- **Fix:** Hint: "영문 소문자와 숫자로 3~20자예요. 밑줄(_)도 쓸 수 있어요". Error: "아이디는 영문 소문자와 숫자로 3~20자로 정해 주세요". Same rule, same validation.
- **Evidence:** `02-signup-step1`. `Onboarding.tsx:126`, `Onboarding.tsx:192`.

## Cognitive Load
- Checklist failures: **1 of 8** (low).
  - *Minimal choices* (borderline): step 2 is one decision ("what is it called?") with five visible answers (free field plus 4 chips), next to a second field and three more controls (back, close, CTA). That is 9 targets in one sheet. Because the field already shows "깽이" and the selected chip repeats it, the selection is said twice.
- Decision points with > 4 visible options: step 2's name choice (5).
- Everything else passes: one focus per step, two fields per step, hints visible, no information carried between steps (step 2 doesn't need the handle).

## Emotional Journey
- **Arrival (01):** calm and inviting. The character carries the warmth and the screen doesn't shout. Good first beat.
- **Step 1 (02):** a drop. "Invent a handle under rules" is the least human moment in the flow, and the sliced headline behind the sheet adds a small "is this broken?" flicker.
- **Step 2 (03):** should be the peak (naming your agent) but feels like a form. The character is dimmed out of view at exactly the moment it is being named.
- **End (chat):** the agent greets you in a different colour with different eyes. The peak-end rule says this last impression colours the whole onboarding, so fixing P2 is worth more than any styling change.
- **Login (04):** neutral until something goes wrong, and then there is no reassurance at all (P1).

## Persona Red Flags
**Jordan (first-timer):** reads "영어 소문자, 숫자, _ 3~20자" literally and hesitates over "_". On step 2, may not realise the "모시 이름" field and the 깽이 chip are the same value, and taps 깽이 to "confirm" it. Sees a red character, then a green one in chat, and wonders whether a different agent was created.

**Casey (one-handed, interrupted):** the primary CTA and the sheets sit in the thumb zone, which is good. The back control ("아이디 다시 정하기") is reachable, but it sits mid-sheet between the chips and the CTA, where a thumb aiming for "모시 만들기" can hit it by mistake. If Casey is interrupted mid-signup, state survives a sheet close (the sheets stay mounted), but not a reload: there is no draft persistence for step 1.

**Sam (screen reader):** the flow is solid. Labels are real `<label>`s via TextField, errors use `role="alert"`, chips are in `role="group" aria-label="추천 이름"`, and the hero blob is `aria-hidden`. One flag: the step-2 back link is announced as "아이디 다시 정하기" in the middle of the form, not as a header-level back action, so the sheet's structure reads oddly.

**Project persona: the busy delegator, "지은"** (from PRODUCT.md Users: non-technical, one-handed, short bursts, expects the app to "talk like a capable person, not like software"). She wants to try the phone-call feature she heard about. Red flags: nothing on the first screen tells her 모시 can make calls, and "찾아보고, 정리하고, 대신 해 드려요" sounds like every chatbot. Step 1 asks her to invent a username under rules, which is software behaviour. If she later forgets the password, she has to start again from scratch.

## Minor Observations
- The invite pill (`.onb-invite`, shown with `?invite=`) gives paper a drop shadow (`0 1px 2px rgb(0 0 0 / .05)`) and uses a literal `border-radius: 18px`. Make it flat (value contrast on `--bg`) and a capsule (`height / 2`), per the Flat Paper and Token Radius rules (`onboarding.css:43-58`).
- `.onb-link` ("다시 시도" in the server-error row) is the only underlined link in the app's chrome (`onboarding.css:70-78`). Use the `.onb-login` treatment (label 600, no underline) for consistency.
- In step 2 the selected chip and the primary CTA are both full `--accent`. That's allowed (selected state), but with the focus ring the sheet shows three blue things at once. Consider dropping the auto-focus on "내 이름", so the ring only appears when the user taps.
- `.onb-title` uses `--t-title1` (28 px) with `line-height: 1.25`. Fine for a display line; the token table in DESIGN.md has no Title 1 row, so add it there for completeness.
- The dark scrim (`rgb(0 0 0 / .5)`) turns the red blob a muddy brown behind every sheet (`02/03/04` dark). If the character stays visible during naming (P2), a lighter onboarding scrim keeps it legible.

## Engine and Theme Differences
- Chromium and WebKit are pixel-equivalent on all four screens: same wraps and same sheet geometry. The step-1 headline slice appears in both.
- Dark: the sheet gets a visible rim (expected opaque-glass edge). The scrim darkens the character into brown-red (see Minor). The text contrast of hints (`--label-2` on `--surface-dark`) holds.
- WebKit dark (spot-checked on `03`) matches Chromium dark.

## Questions to Consider
- What is the real recovery story for a forgotten password: device-key re-auth, the verified phone number (the app already verifies one in 나의 모시), or nothing? The login sheet should say whichever is true.
- What if the first screen let the character prove one thing only 모시 does, for example one line it says in its own voice, instead of a subtitle any assistant could use?
- Does step 1 need a handle at all, given that social sign-in is planned? Could the handle be derived and editable later, so the first thing the user types is the agent's name?
- If the hue is going to be random, should the user see it chosen ("이 색이 깽이 색이에요") and be allowed to re-roll once, the same way they can pick another name chip?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 01, 02, 03, 04.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `low-contrast` | 4 | 01, 02, 03, 04 | 3.6:1 (need 4.5:1) — text #ffffff on #0a84ff | **True positive.** Every primary button fails: white on `#0A84FF` is 3.6:1 against the 4.5:1 needed at 17 px semibold. Fix it at token level: the button fill becomes the existing `--accent-text` `#0071E3`, which gives 4.7:1 (slop-inventory §2). |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** nothing overlaps.
- **B caught, A missed:** **[P1] The one CTA on every onboarding step fails AA**: 시작하기, 다음 and 로그인 are white on `#0A84FF` at 3.6:1. On a Persuade surface this is the most-seen control in the app.
- **A caught, B missed:** no forgotten-password path; the default red blob doesn't match the hue the server assigns afterwards; sheet height jumps between steps; back-link placement.
- **False positives:** none on these screens (no glass group is mounted before sign-in).

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- Assessment A only, isolated: I didn't read the slop inventory, any detector JSON or other critique files, and I didn't run the detector.
- Looked at: all four screens in chromium-light, chromium-dark and webkit-light; webkit-dark spot-checked (`03`); `05-chat-welcome` for the post-signup avatar. Source: `screens/chat/onboarding/{Onboarding.tsx,onboarding.css,state.ts}`, `ui/{AgentBlobLazy,Avatar,TextField,Sheet,Chip,Button}`, `three/AgentBlob.tsx` (looked at, not critiqued), `packages/launcher/src/launcher.ts`, `apps/server/src/profile.ts`.
- Limits: stills only, so no motion findings (the sheet-from-button morph, content swap and loader → check were not judged). The server-error state, invite pill and field-error states were read from source, not seen. The wallpaper was not critiqued, as instructed.
- Rule names quoted from impeccable (Apache-2.0, © Paul Bakaus): the Persuade opening rule, the heuristics scoring guide and the persona set.
