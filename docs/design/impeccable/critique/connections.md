Method: dual-agent (A: critique-a3 · B: impeccable detector over CDP, run by design-director)

# Critique: 연결 (Connections: messengers + ConnectSheet)

2026-11-12 · Mode: Operate · Screens: `38-connections`, `39-connections-scrolled`, `40-connect-sheet-kakaotalk` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | The live pill in the sheet morphs through 연결 중 → 확인 기다리는 중 → 연결됨, and only after the server confirms. Rows show status pills once linked. The disabled 연결하기 doesn't say what is missing. |
| 2 | Match System / Real World | 2 | KakaoTalk speaks plainly. Half the list says "토큰으로 연결", and the Slack sheet tells a consumer to open developer tools and run `JSON.parse(localStorage…)`. "보안 금고(Credential Enclave)의 공개 키" in the lock note. |
| 3 | User Control and Freedom | 3 | Sheet close by ×, drag or scrim. It refuses to close mid-request. Retention is the person's choice. Disconnect takes a hold or two taps. |
| 4 | Consistency and Standards | 2 | Four services share one generic bubble glyph, and three pairs share near-identical hues. The sheet repeats the row's plate at 52 px. The title says "연결된" over a list of things not yet connected. |
| 5 | Error Prevention | 3 | 연결하기 stays disabled until the fields are filled. Scope (can / can't) is shown before input. Retention defaults to 30일. Disconnect is two-step. |
| 6 | Recognition Rather Than Recall | 2 | "슬랙" vs "슬랙 봇" and "디스코드" vs "디스코드 봇" ask the person to already know the difference. The plates don't help, because they are generic glyphs. |
| 7 | Flexibility and Efficiency | 3 | Password-manager autofill (`username` / `current-password`), next/go keys, Enter submits, inputs kept on error. |
| 8 | Aesthetic and Minimalist Design | 2 | A 52 px plate plus a pill as the sheet header, a six-line paragraph, two side-by-side recessed panels, and the same reassurance said four times. |
| 9 | Error Recovery | 3 | A server `lastError` in Korean is shown inline. The row subtitle turns red with the reason, and "다시 연결하기" keeps the inputs. |
| 10 | Help and Documentation | 2 | Per-provider description and scope are good. Token help is a wall of developer steps with no plain-language entry point. |
| | **Total** | **25/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** Two things here are unmistakably 모시. The first is the "깽이가 할 수 있는 일 / 할 수 없는 일" scope, shown before anything is typed, which is principle 2 made visible. The second is the device-sealed login with a retention choice, which is principle 3. No generic template does either. The list itself is the correct iOS inset grouped list with chevrons, and the large title collapses into the top capsule on scroll (`39`). The generic layer is on top. Hue plates with stand-in glyphs (the same speech bubble for LINE, Instagram, Teams and Webex) look like brand marks but identify nothing. The sheet header (big tinted square + status pill) is the stock "integration detail" header of every SaaS settings page. The security reassurance repeats until it reads as anxious rather than calm.

**Deterministic scan.** Pending: Assessment B is joined by design-director.

## Overall Impression
This is the most carefully engineered screen in the 나의 모시 half. The status machine, the sealed credential, the passcode wait, the disconnect hold and the error copy are all right. It fails the user it was written for in two places. Its list mixes a consumer login (카카오톡) with developer setups (tokens, bots, devtools) at equal weight. Its sheet says "we can't see your password" in so many places that the one place it matters, beside the password field, has the least visible version. The biggest opportunity is to sort the list by how hard each connection is, and to say the reassurance once, where the password goes.

## What's Working
- **Scope before input.** The can / can't lists (`ConnectSheet.tsx:354-382`) appear before the form. They show exactly what the agent may do. This is the product's consent principle turned into layout.
- **Form plumbing that respects the person.** Autofill hints (`providerCopy.ts:66-71`), `enterKeyHint` next / go, inputs kept on a failed login, a sheet that refuses to close while a request is in flight, and a live pill whose check draws only on server confirmation (`ConnectSheet.tsx:385-416`). This is organic motion tied to real state, and it should stay.
- **Native list and title behaviour.** The inset grouped list, chevrons and 60 px rows, with the large title morphing into the top capsule (`39`), are what a fluent iPhone user expects.

## Priority Issues

**[P1] Developer setups sit beside consumer logins at equal weight, in developer language**
- **What:** The one list "연결할 수 있는 메신저" has ten rows. Five of them (슬랙, 슬랙 봇, 디스코드, 디스코드 봇, 텔레그램 봇) are subtitled "토큰으로 연결". Opening 슬랙 shows a sheet asking the person to open developer tools, copy the `d` cookie (`xoxd-…`) and run `JSON.parse(localStorage.localConfig_v2).teams` in the console. 디스코드's sheet warns that user-token automation breaks Discord's terms and can get the account banned. The row looks exactly like 카카오톡's.
- **Why it matters:** PRODUCT.md's users are "not technical" and the brief is a "Korean-life agent". A list where half the items are developer procedures tells a first-timer this app is not for them, and a ToS-risky option presented at the same weight as KakaoTalk is a trust problem. It is also a Wall of Options (10 items, one group).
- **Fix:** Keep every provider and every flow. Split by `p.auth` at `ConnectionsScreen.tsx:40`. Section 1, "연결할 수 있는 메신저", holds the account logins (카카오톡, 라인, 인스타그램, Microsoft Teams, Webex). Section 2, "직접 설정해서 연결하는 메신저", holds the token providers, with a section footer: "봇을 만들거나 브라우저에서 값을 복사해야 해요." Row subtitles in section 2 say what is needed in words ("봇 토큰이 필요해요" for bots). 디스코드 (user token) carries its risk in the row: "계정이 정지될 수 있어요" in `--danger`. In the sheet, keep the description to its first sentence. Move the step-by-step token instructions into a collapsed disclosure row under the token field, "토큰 찾는 방법", which needs a `setup` field beside `description` in the provider catalog.
- **Evidence:** `38`, `39` (all engines and themes). `ConnectionsScreen.tsx:40`, `ConnectionsScreen.tsx:60-64`, `providerCopy.ts:16-21`, `packages/messengers/src/providers.ts:57-58` (Slack devtools steps), `:69-70`, `:81-82` (Discord ToS warning), `:93-94`, `:105-106`.

**[P2] The same reassurance appears four times, and the one beside the password is hidden and in jargon**
- **What:** The permission promise appears in the page intro ("내가 허락한 메시지만 보내요"), the sheet description ("허락받은 메시지를 대신 보내요"), the can-list ("허락받은 메시지 보내기") and the can't-list ("허락 없이 메시지 보내기"). The encryption promise appears in the page intro ("로그인 정보는 이 기기에서 암호화돼요"), the can't-list ("비밀번호 원문 보기") and the lock note ("기기에서 암호화돼요. … 보안 금고(Credential Enclave)의 공개 키로 잠근 뒤에만 보내요. 깽이와 서버 운영자도 원문을 볼 수 없어요."). The lock note renders after the retention control, below the fold under the sticky 연결하기 in `40`.
- **Why it matters:** DESIGN's "Say it once" rule keeps this reassurance "only beside the password field". Repetition makes calm copy sound defensive (brand: "no hype"). The version that matters most, at the moment of typing a password (a high-stakes moment per PRODUCT.md), is the one the person is least likely to see, and it is the one with "Credential Enclave" and "공개 키" in it.
- **Fix:** Page intro (`ConnectionsScreen.tsx:86-88`): keep only "메신저를 연결하면 깽이가 대신 대화를 읽고, 내가 허락한 메시지만 보내요." Drop "허락 없이 메시지 보내기" and "비밀번호 원문 보기" from `CANNOT` (`providerCopy.ts:14`), because each is the mirror of a line that stays. The remaining item becomes one closing line of the can-list: "친구 추가·삭제나 설정은 바꾸지 않아요." Move the lock note directly under the 비밀번호 field as its hint, in plain words: "입력한 정보는 이 기기에서 암호화한 뒤에만 보내요. 깽이도 서버 운영자도 원문을 볼 수 없어요."
- **Evidence:** `38`, `40`. `ConnectionsScreen.tsx:86-88`, `providerCopy.ts:6-14`, `ConnectSheet.tsx:303`, `ConnectSheet.tsx:341-345`.

**[P2] The sheet opens with a badge and two boxed columns that squeeze their own text**
- **What:** Under the title "카카오톡", the sheet repeats the row's plate at 52 px (r15) with a "연결 전" pill beside it. It then shows two side-by-side `--surface-2` panels, 할 수 있는 일 and 할 수 없는 일, each about 150 px wide. Four of the seven items wrap to two lines ("허락받은 메시지 / 보내기", "친구 추가·삭제나 설정 / 바꾸기").
- **Why it matters:** The plate identifies the service, and the title already did. A tile above text is the Direction's first removal, and two recessed panels in a sheet are its "card inside a card". The narrow columns make a seven-item list harder to read than a single one.
- **Fix:** Remove `<Plate>` from the sheet head (`ConnectSheet.tsx:265`). The live pill stays on its own line under the title and keeps its width morph and check draw. Render Abilities as one column on the sheet paper. The can-list gets check glyphs at 15 px in `--label`, then the single closing line from the previous issue in `--label-2`. Drop the panel backgrounds and r16 (`connections.css:107-117`).
- **Evidence:** `40` (all engines and themes). `ConnectSheet.tsx:264-270`, `ConnectSheet.tsx:354-382`, `connections.css:102-117`.

**[P2] The provider plates look like brand marks but don't identify anyone**
- **What:** 라인, 인스타그램, Microsoft Teams and Webex all use the same generic speech-bubble glyph. Hues are near-twins for different services: 슬랙 300 vs 슬랙 봇 310, 디스코드 235 vs 디스코드 봇 240 vs Teams 245, 텔레그램 200 vs Webex 190. The 카카오톡 plate is a white glyph on `hsl(50 72% 52%)`, about 1.8:1, so the bubble almost disappears.
- **Why it matters:** The Direction keeps hue plates in 연결 for one reason: to identify a third party. A plate that doesn't identify is decoration, and here it is ten colours of decoration.
- **Fix:** Use each service's official mark, under its brand guidelines, on its brand colour. 카카오톡 is the dark glyph on Kakao yellow, not white on mustard. A bot shares its parent's mark, and the title's "봇" does the distinguishing. Where a licensed mark isn't available, drop that plate rather than draw a stand-in: the names are already distinct. Plate radius `8px` → `--r-tile` scaled (or `height × 0.28`, as `Plate` does) (`List.css:95`).
- **Evidence:** `38`, `39`, `40`. `packages/messengers/src/providers.ts:35-36, 50-51, 65-66, 77-78, 89-90, 101-102, 113-114, 125-126, 140-141, 152-153`, `ConnectionsScreen.tsx:21`, `connections.css:3-14`.

**[P3] The form's first view carries more decisions than it needs**
- **What:** In `40`, under the six-line paragraph, sit two fields, a five-option segmented control (1시간 · 1일 · 7일 · 30일 · 계속) and the pinned button. The paragraph holds four facts in one run, including a broken clause ("처음 연결할 땐 휴대폰 카카오톡에 화면에 보이는 코드를 입력해야 해요."). Disabled 연결하기 is a pale accent fill with a white label (about 1.6:1), so the action's name is barely legible.
- **Why it matters:** Five options at one decision point is past the working-memory rule. A sensible default (30일) is already chosen, so most people never need to see the choice. The passcode step is described before it can happen.
- **Fix:** Put retention behind a disclosure row: "로그인 정보 보관 · 30일 ›", which expands into the same segmented control, so the motion is kept. The description keeps sentences 1–2 and the 2단계 인증 limitation. The passcode sentence moves to the verify phase, where it happens, corrected to "화면에 보이는 코드를 휴대폰 카카오톡에 입력해 주세요." Disabled primary: `--fill` background with a `--label-3` label (the iOS disabled treatment), keeping the accent for when it can be pressed.
- **Evidence:** `40`. `ConnectSheet.tsx:303`, `ConnectSheet.tsx:333-336`, `ConnectSheet.tsx:241`, `packages/messengers/src/providers.ts:42-43`.

## Cognitive Load
- **Checklist failures (3, moderate):** *Chunking*: ten providers in one group. *Minimal choices*: the ten-row list and the five-option retention control. *Progressive disclosure*: token instructions, retention and the passcode explanation are all up front.
- **Decision points with >4 visible options:** the provider list (10, or 8 visible above the tab bar) and retention (5).

## Emotional Journey
The page opens calmly. The intro is honest and the list is native. Then comes the first valley: scanning ten coloured squares and "토큰으로 연결" five times, the person starts to wonder whether this is meant for them. Opening 카카오톡 is reassuring (scope, then a plain form), but the reassurance keeps coming until it sounds like a defence. The high-stakes beat, typing a KakaoTalk password, gets the weakest support, because the encryption line is below the fold and in jargon. The ending is designed well: the pill morphs to 연결됨 with a drawn check, and example prompts appear. That peak should not be spent on a header badge.

## Persona Red Flags
**Jordan (First-Timer):** "토큰으로 연결" means nothing to him. He taps 슬랙 because he uses Slack at work and lands on developer-console instructions. He can't tell 슬랙 from 슬랙 봇. "Credential Enclave" and "공개 키" sit in the reassurance meant for him.

**Sam (Accessibility):** Plates are `aria-hidden`, which is good, but the 카카오톡 glyph at about 1.8:1 fails low-vision recognition where it is meant to help. The can't-list uses `--label-2` and × icons. They read fine, but meaning is carried by the glyph plus words, so it is not colour alone. Disabled 연결하기 at about 1.6:1 doesn't announce why it is disabled. Add an `aria-describedby` hint ("이메일과 비밀번호를 입력하면 누를 수 있어요").

**Casey (Distracted Mobile):** The primary is pinned in the thumb zone, which is good. Retention, the second most consequential choice, sits right above it in five narrow segments of about 64 px each, next to the button. A one-handed mis-tap is easy.

**Project persona: KakaoTalk-first user "민정"** (from PRODUCT.md: non-technical Korean consumer who wants the agent to "summarise KakaoTalk"; the high-stakes moment is "typing a messenger password"). *Red flags:* She opens the screen for exactly one row. She has to read past the intro to find it, and then the sheet tells her about tablets, PCs, codes and 2단계 인증 before she can type. At the password field she sees no line saying the password stays on her phone, because that line sits below the retention control under the button.

## Minor Observations
- The large title "연결된 앱 및 서비스" sits over a list headed "연결할 수 있는 메신저", with nothing connected. "및" is stiff written Korean. The title is pushed as a literal from five call sites (`ProfileScreen.tsx:42`, `ExploreScreen.tsx:49`, `PreDelegateSheet.tsx:80`, `VaultScreen.tsx:95`, `apps/server/src/sdui.ts:41`). "연결" alone, or "메신저 연결", would match the content. One shared constant would keep the shared-title morph consistent.
- The OAuth note hard-codes Microsoft for every `oauth`/`none` provider: "{name} 로그인은 Microsoft 화면에서 직접 해요" (`ConnectSheet.tsx:340`). That is correct for Teams today and wrong for the next OAuth provider.
- Literal radii: sheet plate `radius={15}` (`ConnectSheet.tsx:265`), `.conn-abilities__col` 16 (`connections.css:112`), `.conn-chats-placeholder` 18 (`connections.css:317`). Elsewhere in the same feature: `.more-sheet-rows` 18 and `.more-sheet-row__icon` 9 (`more.css:133, 173`).
- The manage view (not captured) repeats the icon-tile pattern: 30 px `--fill` tiles for person, clock and chat-kind (`ConnectSheet.tsx:461-475`, `:498-500`).
- After connecting, the example prompts are full-sentence chips (`ConnectSheet.tsx:423-433`). DESIGN keeps chips for choices among peers. These are choices, but they wrap like prose. Plain rows with a chat glyph would read better. Not captured, so source only.
- Text fields are outlined (`--surface` + hairline, `ui/TextField.css:21-23`), while DESIGN.md specifies filled fields (`--fill`). This is system-wide, so the decision belongs to the foundation, not to 연결.

## Engine and Theme Differences
- **Chromium applies `text-wrap: pretty`** to the sheet description (`more.css:122`) and breaks before "처음 연결할 땐". WebKit runs it as one ragged paragraph. Both are acceptable. Splitting the paragraph (P3) removes the difference.
- **Dark:** plates drop to 60 % / 46 %, and the 카카오톡 glyph improves to about 2.5:1. Disabled 연결하기 becomes a dim navy with a grey label, even less legible than in light. The avatar dot sits on a white disc in the name capsule (shared chrome).
- **Hover tint captured on a row** (슬랙 봇 in `38`, 디스코드 봇 in `39`) in every engine. This is the capture pointer resting at that height, not a stuck touch state (`ui/List.css` gates hover on `(hover: hover)`). Noted so it isn't filed as a bug.

## Questions to Consider
- Do the token providers belong on this screen for the users PRODUCT.md describes, or behind a "고급 연결" row at the bottom? The function stays, and the default screen becomes the five logins.
- What does the 디스코드 user-token row owe the person, given that its own sheet says it can get their account banned? Is equal billing with 카카오톡 a recommendation the product means to make?
- What would this sheet look like if the scope list were the only reassurance, and the password hint the only security line?
- With real logos unavailable for some services, are plates still worth having on this list at all?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 38, 39, 40.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `skipped-heading` | 6 | 38, 39, 40 | <h1> "보관함" followed by <h3> "11월 12일 주간회의 회의록" (missing h2); <h1> "연결된 앱 및 서비스" followed by <h3> "연결할 수 있는 메신저" (missing h2) | **True positive.** `SectionLabel` renders `<h3>` straight after the page `<h1>` (`screens/more/parts.tsx:93`), so VoiceOver's heading rotor skips a level. Make it `h2`. |
| `organic-clip-path` | 3 | 38, 39, 40 | clip-path: path() with 12 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |
| `low-contrast` | 1 | 40 | 4.4:1 (need 4.5:1) — text #6e6e73 on #efeff0 | **True positive.** Use `label` on fills (see the snippet). |
| `low-contrast` | 1 | 40 | placeholder 2.0:1 (need 4.5:1) — text #b9b9bb on #ffffff | **Minor.** Every field has a visible label, so this is not blocking. Raise placeholders to about 3:1 (`#8e8e93`). |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** A's placeholder-copy note sits on the same field B flags at 2.0:1.
- **B caught, A missed:** (연결하기 was disabled in the capture; once enabled it inherits the 3.6:1 accent-fill issue found elsewhere.) **[P2]** `conn-livepill--none` is 4.4:1. **[P2]** heading skip `<h1>` → `<h3>` (연결할 수 있는 메신저).
- **A caught, B missed:** developer-grade token setups listed at equal weight with KakaoTalk; the reassurance repeated 3–4 times with jargon; the sheet's plate plus can/can't panels; provider plates that don't identify the brand (the Kakao glyph at about 1.8:1).
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- Looked at: chromium-light, chromium-dark and webkit-light for `38`–`40`. Spot-checked webkit-dark `40`. Read `ConnectionsScreen.tsx`, `ConnectSheet.tsx`, `providerCopy.ts`, `connections.css`, `parts.tsx`, `more.css`, `ui/List.css`, `ui/TextField.css` and the provider catalog in `packages/messengers/src/providers.ts` (description, hue and icon strings reach the UI unchanged). Skimmed `Passcode.tsx`.
- Limits: stills only. The connected, verifying, passcode and manage states were not captured (fresh account), so they were judged from source. The agent hue is pink on this account (fixture). Contrast figures are computed from the plate HSL values in CSS, not measured from pixels. Detector not run (isolation rule). Nothing under `apps/` or `packages/` was modified.
