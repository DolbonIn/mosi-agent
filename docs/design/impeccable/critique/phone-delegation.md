Method: dual-agent (A: critique-a2 · B: impeccable detector over CDP, run by design-director)

# Critique: 전화 대행 (Phone calls on the user's behalf)

2026-11-12 · Mode: Operate · Screens: `08-chat-cards-latest-phone-approval`, `37-phone-sheet` · Chrome + WebKit, light + dark, 390×844

Scope: the high-risk call approval card (with its receipt and the call thread's event note), the 내 전화번호 sheet (PhoneSheet), and the `call-demo` opener `CALL_DEMO_GREETING`.

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | The pending state, the confirm-step label, the receipt with time and the device-key line are all there; PhoneSheet has busy/success labels and a tabular resend countdown. After the call there is only a one-line event note: no answered/unanswered, no duration. |
| 2 | Match Between System and Real World | 2 | "연세바른치과께" puts a person's honorific on a clinic. The enter step of PhoneSheet says "깽이가 이 번호로만 전화를 걸어요", which reads as "only this number, ever". "외부 통화" is system talk. |
| 3 | User Control and Freedom | 3 | 취소 on the card, a two-step or hold confirm, sheet close, "번호 바꾸기". Once dialled, nothing in the card lets you stop the call. |
| 4 | Consistency and Standards | 2 | A medium-risk message gets a labelled preview, but a high-risk call gets its script buried in one prose sentence. 취소 is blue text (accent) while every other secondary is neutral. A red badge marks a state that isn't an error. |
| 5 | Error Prevention | 2 | Hold 1.2 s or two taps is right, but the number being approved is masked (`02-***-1234`), so a wrong number can't be caught. The card says it will ask a question, yet the call can't hear an answer. |
| 6 | Recognition Rather Than Recall | 3 | The card carries who, number (masked) and words. The user still has to remember the real number to check it (P1). |
| 7 | Flexibility and Efficiency of Use | 2 | Hold and two-tap are both accelerators, but the script and the number can't be edited from the card. Every correction means re-asking in chat. |
| 8 | Aesthetic and Minimalist Design | 2 | Icon tile, red "확인 필요" badge, quote-in-prose and a blue 취소 all compete inside one card. PhoneSheet is clean. |
| 9 | Help Users Recognize, Diagnose, and Recover from Errors | 3 | PhoneSheet errors sit at the field, the code clears and refocuses, resend waits 30 s. The approval card shows the server error inline (`role="alert"`). |
| 10 | Help and Documentation | 2 | "인증 전화는 해외 번호(+1)로 걸려 와요" is good just-in-time help. The hold gesture is explained only to screen readers (sr-only hint). |
| | **Total** | **24/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** This is the feature that makes 모시 more than a chatbot, and the logic underneath is specific and careful. Risk tiers come from MOTION-SPEC §8.6: hold-to-confirm with an equivalent two-step tap, a signature with the device key, and a receipt that says "이 기기의 키로 확인했어요" only after the access log verifies it. Calls play in the agent's own Korean voice. None of that is generic.

The card's surface, though, is the stock approval card any agent product ships: an icon tile, a bold question, a coloured status pill and two buttons. It doesn't look like what it is, the exact words a stranger is about to hear from you, spoken over the phone. The specific opportunity is to make the script the hero of the card: set as speech, with the full number above it and one honest line about what the call can and cannot do. PhoneSheet is properly product-specific: four OTP cells, a self-submitting code, and an honest warning that the verification call comes from a +1 number.

**Deterministic scan.** Pending: Assessment B, joined by design-director.

## Overall Impression
The safety model is right and the micro-craft of PhoneSheet is good. The approval card lets the user down at the exact moment PRODUCT.md calls high-stakes. The user can't see the number they authorise. They aren't told the call is one-way, even though they asked the agent to *ask* something. And the most important text, the words the clinic will hear, is the least structured thing in the card. The biggest opportunity is to rebuild the card around "number + script + what happens next" and remove the badge and tile.

## What's Working
- **Hold or tap twice, in the same place.** `ConfirmButton` gives the high tier a 1.2 s linear fill and an equivalent two-step tap. The first tap swaps the label to "한 번 더 누르면 실행돼요". Both paths work for keyboard and screen-reader users (`ui/ConfirmButton.tsx:38-53`, `ui/Button.tsx:20-22`). That covers §8.6 without punishing accessibility.
- **The receipt doesn't overclaim.** The card flips only when the server accepts. It folds into "승인했어요 · 시각", and adds "이 기기의 키로 확인했어요" only once the access log shows a device-verified signature (`ApprovalCard.tsx:40-52`, `:140-157`). This is "Nothing leaves without consent" made visible.
- **PhoneSheet is a model form.** A real `<input autocomplete="one-time-code" inputmode="numeric">` drives four cells and submits on the fourth digit. A wrong code clears and refocuses. Resend waits 30 s with a tabular countdown. The +1 caller-ID warning appears before the call rings, which is exactly when the user needs it (`PhoneSheet.tsx:127`, `:163-188`, `:217-242`).

## Priority Issues

**[P1] The user approves a number they cannot read**
- **What:** The approval detail masks the number the agent is about to dial: "02-***-1234로 전화해서 …". The masking is done server-side for logs and the LLM, but the same string is what the user signs.
- **Why it matters:** The approval is the only guard against a wrong or hallucinated number. With the middle digits hidden, the user can't compare it with the clinic's real number. They're signing blind, with their device key. PRODUCT.md: "Outbound actions wait for a device-signed approval whose preview shows **exactly** what will be sent or said."
- **Fix:** Send the full number to the device only, as its own card field (for example `card.to`), and keep the masked form in the stored text the LLM sees. In the card, render it as its own line under the title: target and number, `--t-body`, `tabular-nums`, `--label` (for example "연세바른치과 · 02-1234-1234"). Then drop the number from the sentence. When the number could not be normalised, keep today's "번호 확인 필요", and in that case disable the confirm button.
- **Evidence:** `08-chat-cards-latest-phone-approval` (all engines). `apps/server/src/phone.ts:336-345` (detail built with `maskPhone(n)`), `phone.ts:65-72` (`maskPhone`), `ApprovalCard.tsx:94-98` (detail rendered as one paragraph).

**[P1] The card promises a question; the call can only speak**
- **What:** The user asked "예약 되는지 전화해서 물어봐 줘". The card says it will say "…진료 예약이 가능한지 여쭤봐도 될까요?". But `sys_phone_call` plays one TTS message (`<Play>` / `<Say>`) and hangs up: there is no `<Gather>`, recording or transcript, so no answer can come back. The call thread then records only "…께 전화를 걸었어요. 전한 말: …".
- **Why it matters:** PRODUCT.md promises "phone a business or person on their behalf **and report back**", and principle 1 is "Done, then shown". Here the user approves expecting an answer and gets silence. That is a support ticket (P1), and it teaches the user not to trust the agent's wording. The clinic also hears a question it can't answer.
- **Fix:** Until two-way calls exist, add one line under the script in the high-risk card for calls: "이 말을 전하고 끊어요. 상대의 대답은 들을 수 없어요." (`--t-footnote`, `--label-2`). Keep the same line in the call thread's event note after the call. When the requested message is phrased as a question, the agent prompt should rewrite it as a message that asks for a call back to the user. That's a product call; see Questions.
- **Evidence:** `08-…` (the script ends "여쭤봐도 될까요?"). `apps/server/src/phone.ts:1-10` (one-way design), `phone.ts:45-49` (`<Play>`/`<Say>` only), `phone.ts:316-318` (tool description: "speak a short Korean message").

**[P1] "제 전화, 먼저 한번 받아 보실래요?" opens a thread that asks for someone else's number**
- **What:** The `call-demo` row, its sheet and its CTA all promise the agent will call *you* ("지금 바로 전화를 걸어요", "내 휴대폰으로 전화 걸기", "승인하면 바로 전화가 와요", "전화 받아 보기"). The server even titles the thread "하늘님께 전화". But the first message in that thread is `CALL_DEMO_GREETING`: "누구에게 어떤 용건으로 전화할까요? 상대 번호와 하고 싶은 말을 알려 주시면, 걸기 전에 한 번 더 확인받을게요." That is a different task.
- **Why it matters:** This is the top row of 둘러보기, the first time most users meet the phone feature. They tap "전화 받아 보기" and are asked for a stranger's phone number. They hesitate (Jordan) or abandon.
- **Fix:** Make the greeting match the promise, and use the call-the-user path that already exists (`sys_call_me` → the verified number from 내 전화번호). Make the greeting a template rendered with `{displayName}`, like the other seeds: "{displayName} 님 휴대폰으로 지금 걸어 볼게요. 다른 분께 걸 때와 똑같은 목소리로 들려 드려요." If no verified number exists, the greeting says "먼저 내 전화번호를 인증해 주세요" and the thread offers one neutral button that opens `presentPhone`. The pre-delegate sheet should list that need too (see explore.md).
- **Evidence:** `24-predelegate-sheet` (the promise). `apps/server/src/explore.ts:39` (greeting), `explore.ts:41-52` (template copy), `explore.ts:421-445` (thread "…님께 전화" + greeting). `apps/mobile/src/screens/more/explore/templateInfo.ts:51`, `:122`.

**[P2] The approval card is assembled from generic parts, and the script is the weakest one**
- **What:** The head has a 36 px rounded-square icon plate (`.appr-icon`), a bold title, and a red `--danger` pill "확인 필요" that repeats the question the title already asks. The body is one 15 px paragraph mixing the masked number, a colon, and the script in curly quotes. 취소 renders in `--accent-text` blue (`variant="plain" tone="secondary"` resolves to accent), making it the screen's second blue control. Medium-risk approvals get a labelled "보낼 내용" panel, but the high-risk call gets less structure than a chat message.
- **Why it matters:** DESIGN.md's direction removes exactly these: icon tiles beside text, red used as decoration ("never decoration"), and one accent per screen. More importantly, the words the clinic will hear are the hardest thing to scan. WebKit even leaves the opening quote mark dangling at the end of line 1.
- **Fix (keeps function):** remove `.appr-icon` (`ApprovalCard.tsx:82-84`, `cards.css:332-340`). Remove the "확인 필요" pill for the high tier: the confirm button's two-step label already carries the weight. Layout, top to bottom: title (`--t-body` 600), number line (P1 fix), then the script as its own block of speech, `--t-callout` 16 px, `line-height: 1.55`, indented 12 px, wrapped in “ ” with no panel and no side stripe. Then the one-way line (P1 fix), then the full-width ConfirmButton. Below it, 취소 as `variant="plain" tone="neutral"` (`--label`). Fix the grammar in the same pass: title "연세바른치과에 전화할까요?" (see P2 below).
- **Evidence:** `08-…` light/dark, Chrome/WebKit (WebKit wraps after the opening “). `ApprovalCard.tsx:81-87`, `:94-98`, `:111`. `cards.css:34-44` (badge, literal r12), `cards.css:332-351`. `ui/Button.css:121-125` (plain → `--accent-text`).

**[P2] Korean copy: a person's honorific on a clinic, and an ambiguous promise in PhoneSheet**
- **What:** (a) Call titles always use `${target}께`. `who()` also appends 님 to any name, so a business becomes "연세바른치과님께". This flows into the approval title, the thread title ("연세바른치과께 전화") and the event note. (b) PhoneSheet's first step says "깽이가 이 번호로만 전화를 걸어요". A user who just approved a call to a clinic reads that as "it can only ever call me". The done step already has the precise sentence ("모닝콜이나 알림 전화를 이 번호로만 걸어요").
- **Why it matters:** Principle 5, Korean first: josa handled correctly. "께" for an institution reads like machine output. The PhoneSheet line makes the user doubt the feature they're setting up.
- **Fix:** (a) In `who()`/`callTitle()`, don't append 님 when the name ends in an organisation noun (치과, 병원, 의원, 약국, 센터, 은행, 식당, 가게, 회사, 사무실, 주민센터…). Use "에" for those: "연세바른치과에 전화할까요?" / "연세바른치과에 전화" / "연세바른치과(02-1234-1234)에 전화를 걸었어요". Keep "님께" for people ("단아님께"). (b) Enter step lead: "{깽이}가 모닝콜이나 알림 전화는 이 번호로만 걸어요. 인증 전화로 번호를 확인해요." Use `josa()` as today, and the same sentence shape as the done step.
- **Evidence:** `08-…`, `20-drawer` ("연세바른치과께 전화"), `37-phone-sheet`. `apps/server/src/phone.ts:297-306`, `phone.ts:342`. `PhoneSheet.tsx:100` vs `PhoneSheet.tsx:292`.

## Cognitive Load
- Checklist failures: **3 of 8** (moderate).
  - *Chunking:* the card body is one paragraph holding three different things: the number, the instruction, and the script.
  - *Visual hierarchy:* the red pill is the most saturated element in the card and competes with the title. The script, which matters most, has the same weight as the framing sentence.
  - *Working memory:* to check the call, the user has to remember the clinic's real number and match it against "02-***-1234" (a Memory Bridge, and an impossible one).
- Decision points with > 4 visible options: none. The card offers exactly two actions; PhoneSheet offers one per step (code step: 확인하기, 다시 걸기, 번호 바꾸기 = 3).

## Emotional Journey
- **Ask (user bubble):** confident: "전화해서 물어봐 줘".
- **Approval (08):** this should be the reassurance peak ("you're in control; this is exactly what will happen"). Instead the red "확인 필요" reads as a warning and the number is hidden. The user feels a little anxious and has to take it on trust.
- **Confirm:** the hold fill and two-step label feel deliberate and safe (good). The device-key receipt is a nice end beat.
- **After the call:** the valley. A one-line note says the message was delivered, and the question the user asked never gets an answer. Peak-end: the memory of the feature becomes "it called, but I still don't know".
- **PhoneSheet (37):** calm and well-paced. The +1 warning prevents the "who is this?" moment when the verification call arrives.

## Persona Red Flags
**Riley (stress tester):** asks "연세바른치과에 전화해 줘" when the agent picked the wrong branch's number. The card shows "02-***-1234", which Riley can't distinguish from the right one. Riley asks a yes/no question and watches the thread for the answer that never comes. In PhoneSheet, Riley pastes "+82 10…" and long strings: `formatPhoneInput` copes, and `looksDialable` (≥ 9 digits) keeps the CTA disabled until plausible. That part holds.

**Sam (screen reader / motor):** two-step tap works with VoiceOver and keyboard, and the hint "길게 누르거나, 두 번 눌러 확인해요" is exposed via `aria-describedby`. Good. But the hint is `sr-only`, so a low-vision sighted user who relies on hold never learns it exists. The red "확인 필요" pill is colour plus words (OK), but it duplicates the title for every listener.

**Casey (one-handed):** the confirm button is mid-card. When the card is at the bottom of the thread (as in 08), the button lands in the thumb zone. A 1.2 s hold one-handed while walking is fine, and the two-tap alternative helps. 취소, as blue text, sits 44 px below the confirm: a miss-tap lands on cancel, which is the safe direction. Good.

**Project persona: "지은", the delegator who hands off a call** (PRODUCT.md Users: non-technical, expects the agent to act like a capable person and report back). Red flags: she can't confirm the number. She expects the agent to come back with "3시 가능하대요" and gets "전화를 걸었어요". "연세바른치과께" sounds like a robot wrote it. If she started from 둘러보기's "제 전화, 먼저 한번 받아 보실래요?", the agent asked her for someone else's number instead of calling her.

## Minor Observations
- The confirm hint "길게 누르거나, 두 번 눌러 확인해요" is screen-reader only (`ui/Button.tsx:301-304`). Sighted users discover the two-tap by tapping, which is fine, but the hold path is invisible. Showing it once as a `--t-footnote` line under the first high-risk card a user ever sees would teach it without clutter.
- The PhoneSheet disabled CTA is the accent at `opacity: .4` (pale blue in light, navy with grey text in dark; `ui/Button.css:144-147`). iOS disabled buttons are neutral; a disabled state in `--fill` with `--label-3` text would stop the pale blue reading as a "soft primary".
- PhoneSheet's done step nests a 44 px icon tile (`r12`, `--surface`) inside a `--fill` panel inside the sheet, which is a card in a card with an icon plate (`phone.css:119-136`). The number and "인증됨" can sit as a plain row.
- Spacing of 님 is inconsistent: "하늘님께 전화" (thread title, `explore.ts:427`) vs "하늘 님 대신 연락드렸어요" (script). Pick one form app-wide.
- The thread subtitle "깽이의 외부 통화" is a type label, not information. After the call it could carry the outcome (see drawer.md).
- The script in 08 opens with "하늘 님 대신 연락드렸어요" and never says the caller is an automated voice. That's not a design defect, but recipients will ask "누구세요?". See Questions.
- Glass count on 08 is five shapes (menu, name capsule, 초대, composer, tab bar). That's chat chrome, outside this feature, but it is the backdrop every approval card sits on.

## Engine and Theme Differences
- **WebKit, light and dark (`08`):** the detail paragraph breaks right after "전할게요: “", leaving the opening quotation mark alone at the end of line 1. Chromium starts the quote on line 2. The P2 fix (script as its own block) removes this.
- **WebKit (`37`):** the lead "깽이가 이 번호로만 전화를 걸어요. 인증 전화로 …" wraps one word earlier ("인증 / 전화로"), because WebKit applies `text-wrap: pretty` more aggressively. Harmless, but the sheet grows one line taller in Safari.
- **Dark (`08`):** the red pill becomes a dark-red tint with salmon text and is still the loudest element. The card hairline replaces the shadow, which is correct.
- **Dark (`37`):** the disabled CTA is navy with grey text, which reads more clearly as disabled than light's pale blue.

## Questions to Consider
- Should a call whose purpose is a question be allowed at all before two-way calls exist, or should the agent turn it into "please call 하늘 back" automatically?
- Who is the approval protecting: the user from a wrong number, or the number from the logs? Can both hold: full number on the device, masked in storage?
- Should recipients hear who is calling ("모시라는 AI 비서로 연락드렸어요")? It changes the script template, not the UI, and it may be the difference between a hang-up and an answer.
- Could the approval card let the user edit the script inline before holding, so "말을 조금 바꿔 줘" doesn't need another chat turn?
- Once the call ends, what is the record? A receipt card with "전화를 걸었어요 · 0:42 · 연결됨" would make "Done, then shown" true for calls.

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 08, 37.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `low-contrast` | 1 | 08 | 4.4:1 (need 4.5:1) — text #6e6e73 on #efeff0 | **True positive** (`.ccard-badge`): 4.4:1. Put the badge text in `label`. |
| `low-contrast` | 2 | 08, 37 | placeholder 1.9:1 (need 4.5:1) — text #afafb2 on #efeff0; placeholder 2.0:1 (need 4.5:1) — text #b9b9bb on #ffffff | **Minor.** Every field has a visible label, so this is not blocking. Raise placeholders to about 3:1 (`#8e8e93`). |
| `low-contrast` | 1 | 08 | 3.6:1 (need 4.5:1) — text #ffffff on #0a84ff | **True positive.** Every primary button fails: white on `#0A84FF` is 3.6:1 against the 4.5:1 needed at 17 px semibold. Fix it at token level: the button fill becomes the existing `--accent-text` `#0071E3`, which gives 4.7:1 (slop-inventory §2). |
| `low-contrast` | 1 | 08 | 4.1:1 (need 4.5:1) — text #6e6e73 on #e6e6e9 | **True positive** (`.msg-event`): 4.1:1. Remove the pill and set the note as centred footnote text on the background (4.9:1), or use `label` on the fill. |
| `organic-clip-path` | 3 | 08, 37 | clip-path: path() with 12 curve segments; clip-path: path() with 16 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |
| `skipped-heading` | 1 | 37 | <h1> "보관함" followed by <h3> "11월 12일 주간회의 회의록" (missing h2) | **True positive.** `SectionLabel` renders `<h3>` straight after the page `<h1>` (`screens/more/parts.tsx:93`), so VoiceOver's heading rotor skips a level. Make it `h2`. |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** nothing overlaps directly.
- **B caught, A missed:** **[P1]** the 전화 걸기 primary is 3.6:1 (white on accent). **[P3]** the phone-number placeholder is 2.0:1.
- **A caught, B missed:** the masked number on the approval (02-***-1234) means a wrong number can't be caught; a one-way TTS call is framed as a question; the call-demo greeting contradicts the promise to call the user.
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- Assessment A only, isolated: I didn't read the slop inventory, any detector JSON or other critique files, and I didn't run the detector.
- Looked at: `08` and `37` in chromium-light, chromium-dark, webkit-light and webkit-dark; `20-drawer` and `24-predelegate-sheet` for the thread title and the call-demo promise. Source: `screens/chat/cards/{ApprovalCard.tsx,cards.css}`, `screens/chat/util.ts` (risk), `ui/{ConfirmButton,Button}.tsx/.css`, `screens/more/profile/{PhoneSheet.tsx,phone.css,phone.ts}`, `apps/server/src/phone.ts`, `apps/server/src/explore.ts` (`CALL_DEMO_GREETING`, the call-demo seed and delegate).
- Limits: stills only. The hold fill, label swap and receipt morph were read from source, not watched. The card text in `08` is fixture data: the title "연세바른치과께" and the masked "02-***-1234" format come from the fixture, but the server templates produce the same pattern (`phone.ts:342-343`). No call was placed: the one-way nature comes from the server code and tool description. No "call card" component exists beyond the approval card, its receipt and the thread's event note; those were reviewed as the call card.
- Rule names quoted from impeccable (Apache-2.0, © Paul Bakaus): heuristics guide, persona set, cognitive-load checklist.
