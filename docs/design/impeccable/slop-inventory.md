# Slop inventory: 모시 mobile, current app (2026-11-12)

Written by design-director for the de-slop pass. The user asked for this direction in these words:
"지금 디자인 전반적으로 유기적인 모션은 남기고 slop을 지우는 방향으로 진행". The calm wallpaper
("뒤에 그라데이션 배경이 너무 slop인데 60fps 참고해서 깔끔하게 바꿔줘") is owned by the `wallpaper` teammate and has
already landed (one top-edge radial light tinted by the agent hue, plus dither). This inventory assumes it and does not
list the background.

**Method.** This follows the impeccable method: the craft-floor ban list, detector rule IDs and `critique.md`
(github.com/pbakaus/impeccable, Apache-2.0, © Paul Bakaus; rule names are quoted with attribution and no files are
copied). Evidence comes from three sources:

1. **Source scan** of `apps/mobile/src/**` and the server strings that reach the UI.
2. **Screenshots** of the built app at 390×844 @2x in Chrome and WebKit, light and dark: 50 screens per pass, 200 in
   all. A throwaway account and data dir were used, with fixtures for the cards.
   - Files are in `docs/design/impeccable/shots/` and are indexed in `shots/index.json`.
   - Reproduce with `node docs/design/impeccable/capture.mjs` (options are in the file header).
3. **The impeccable detector**, run per rendered screen over CDP: `impeccable detect --cdp <port> --json`, Chrome
   light, all 50 screens.
   - The engine was checked against `engine-checksums.txt`.
   - Nothing was installed and no hooks were enabled.

The brief wins. PRODUCT.md and DESIGN.md (both in `apps/mobile/`) set the rules: two layers, one accent, ≤3 visible
glass shapes, flat paper, token radii, 해요체, and no emoji in UI chrome. An item counts as "slop" here when it breaks
those rules or matches a named tell. Taste alone does not make an item slop.

**Classes**

| Class | Meaning | Who acts |
| --- | --- | --- |
| **R: remove now (safe)** | A mechanical fix. It changes no layout decision or flow and can land without a draft. | Screen team, directly |
| **D: needs a draft decision** | Structural: the fix changes a composition, so it needs an A/B draft first. | Draft team, then screen team |
| **K: keep (intentional)** | It looks like a tell but is deliberate and justified, so it stays. | Nobody |

**Motion is never listed as slop here** unless it breaks MOTION-SPEC. See §9; nothing in the motion system was found
to break it.

Shot names are given as `NN-name`. They resolve to `shots/<engine>-<theme>-NN-name.jpg`; Chrome light is the default
view.

---

## 1. Top 10

These are ranked by how much each item makes the app read as "AI-generated": how often it appears multiplied by how
visible it is.

| # | Tell | Where (main) | Screens | Class |
| --- | --- | --- | --- | --- |
| 1 | **Icon-tile stacks.** A rounded-square plate with a glyph sits above or beside every title: 18 plate classes, about 9 different sizes and 7 radii. | `ui/List.css:88`, `screens/more/more.css:10`, `screens/chat/cards/cards.css:87/115/206/300/332/504`, `screens/chat/chat.css:73/816`, `screens/chat/drawer.css:141` | nearly all (05–50) | D (rows), R (tiles over headings) |
| 2 | **Cards in cards / stacked paper.** Each assistant reply is a paper bubble with a separate paper card under it. Inside the cards sit recessed `surface-2` panels: hourly tiles, the messenger quote panel, the approval preview, the can/can't panels and the pre-delegate fact tiles. | `chat.css:157`, `cards.css:13/160/265/352`, `connections/ConnectSheet.tsx:357`, `explore/PreDelegateSheet.tsx:171` | 08–16, 24, 40 | D |
| 3 | **The same reassurance said 6+ times.** "기기에서 암호화돼요 · 모시도 볼 수 없어요" appears in the welcome message, the credential card, Connections, the Connect sheet, Vault, the Payment steps, the Profile privacy card and the Privacy sheet. | `server/src/auth.ts:150`, `cards/CredentialCard.tsx:132`, `connections/ConnectionsScreen.tsx:87`, `ConnectSheet.tsx:343`, `vault/VaultScreen.tsx:84`, `payment/PaymentScreen.tsx:35-38`, `profile/ProfileScreen.tsx:197-203`, `profile/PrivacySheet.tsx:44-46` | 05, 12, 29, 33, 38, 40, 43, 49 | R (copy), D (which place keeps it) |
| 4 | **Up to 6 glass shapes at once on chat.** Menu, name and 초대 capsules, plus the jump-to-latest capsule, the composer and the tab bar. The brief allows ≤3. | `app/TopBar.tsx:31/49/121`, `screens/chat/ThreadView.tsx:326`, `Composer.tsx:209`, `app/TabBar.tsx:165` | 05–17 | D |
| 5 | **Two-layer "soft lift" shadow on flat paper**, copy-pasted in 11 places (`0 1px 2px /.04, 0 8px 24px /.05–.06`). DESIGN.md's **Flat Paper** rule says paper sits flat in light mode. | `ui/Card.css:9`, `ui/List.css:30`, `cards.css:13`, `chat.css:81/157/825`, `ui/Spotlight.css:137`, `explore.css:76/107/129`, `chat/onboarding/onboarding.css:54`, `ui/Button.css:76` | all paper screens | R |
| 6 | **Radius sprawl.** 106 literal `px` radii against 28 token uses, across 21 distinct values (6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 18, 19, 20, 22, 24, 26, 28, 34 …). This breaks concentricity. | top offenders `chat.css` (14), `cards.css` (13), `drawer.css` (8) | all | R (map to tokens) |
| 7 | **Welcome card duplicates itself.** "이런 일을 맡겨 보세요" has 4 icon-tile rows, and then 4 chips that repeat the same 4 actions. It sits under a 3-paragraph wall of text. | `server/src/auth.ts:136-150`, `cards/InfoCards.tsx:39-45`, `cards.css:87` | 05, 06 | D |
| 8 | **Empty thread is the AI template.** A sparkles icon tile with a shadow, a centred title and body, and 3 identical grey pills stacked in the centre. | `chat/EmptyThread.tsx:13-27`, `chat.css:816-825` | 07 | D (draft supplied) |
| 9 | **Extra colours outside the one accent.** Explore category pastels (5 hues), hue icon plates on templates, kind colours in Archive (blue / green / orange), ticket glyphs (blue + purple), and a blue text "취소" next to the blue primary button. | `explore.css:61-80`, `more.css:10`, `archive/ArchiveScreen.tsx:170`, `profile/profile.css:130-135`, `cards/ApprovalCard.tsx:112/118` | 08, 22–25, 29 | D (hues), R (취소 to neutral, tickets to label colour) |
| 10 | **Social proof and filler copy without evidence.** "17,166명이 맡겼어요" comes from seeded constants. Also: "나만의 AI 에이전트", "{이름} 님의 AI 에이전트", and the "문서" kicker above artifact titles. | `server/src/explore.ts:51…147` (via `seedCount`), `explore/ExploreScreen.tsx:121-132`, `app/Drawer.tsx:84`, `chat/ChatScreens.tsx:200`, `cards/ArtifactCard.tsx:31` | 15, 20, 22 | R |

---

## 2. Detector findings (Assessment B)

Run: `impeccable detect --cdp 9333 --json` on each of the 50 rendered screens. Chrome light, 390×844, logged-in
throwaway account, card fixtures. 50/50 screens scanned, 0 errors, **0 screens clean**. Raw output:
`detect.json` in the capture output dir (not committed; reproduce with `CAP_DETECT=<launcher> node
docs/design/impeccable/capture.mjs`).

The detector found **no AI-tell rules** (`side-tab`, `gradient-text`, `ai-color-palette`, `icon-tile-stack`,
`nested-cards`, `hero-eyebrow-chip`, `dark-glow`, `bounce-easing` …) on any rendered screen. The tells in §3 are real,
but they are shaped in ways its DOM heuristics do not match. The icon plates are `span`s with no sibling heading, and
the nested panels are recessed `surface-2`, not bordered cards. Everything it did flag is a **quality** rule:

| Rule ID | Hits | Screens | What | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| `low-contrast` | 18 | 01–04, 08–19, 24, 49 (every primary button) | **White on `#0A84FF` = 3.6:1** (needs 4.5:1 at 17 px semibold) | **D (token)** | The fill of primary buttons uses a darker blue that already exists as `--accent-text` `#0071E3` (white on it = 4.7:1), in both themes. `#0A84FF` stays for tint, selection and the active tab. One accent, two values. Needs a lead/user nod because it shifts the brand blue on buttons. |
| `low-contrast` | 12 | 08–19 | `.msg-event` `#6e6e73` on `#e6e6e9` = **4.1:1** | R | = GT-1 |
| `low-contrast` | 12 | 08–19 | `.ccard-badge` `#6e6e73` on `#efeff0` = 4.4:1 | R | Badge text in `label`, or drop the badge fill (CH-4 keeps the words). |
| `low-contrast` | 1 each | 20, 21, 36, 40 | `.dw-search` placeholder row 4.0:1; Spotlight `spot-row-sub` `#daedff` on accent 3.0:1; destructive button `#d70015` on `#f6dfdf` 4.2:1; `conn-livepill--none` 4.4:1 | R | Use `label` on fills. The destructive tint button uses `#c00012`, or a plain red text button. |
| `low-contrast` (placeholder) | 15 | 08–19, 37, 40, 44 | Placeholders `#afafb2` / `#b9b9bb` at 1.9–2.0:1 | R (minor) | Every field has a visible label, so this is not blocking. Still, raise `--label-3`-as-placeholder to about 3:1 (`#8e8e93`). |
| `low-contrast` (pixel) | 2 | 20, 21 | Tab label under the drawer scrim, 2.3:1 | K | Transient. The drawer is modal and the tab bar is inert under it. |
| `skipped-heading` | 34 | 25–50 (all of 나의 모시, 보관함, settings) | `<h1>` then `<h3>`: `SectionLabel` renders `h3` | **R** | `screens/more/parts.tsx:93` should use `h2` (or take `as`). VoiceOver rotor users hit a missing level on every More screen. |
| `organic-clip-path` | 55 | 05–50 | `clip-path: path()` with 12–16 curves on `body` | **K** | This is the Liquid Glass group union (`ui/Glass.tsx:234`): the glass layer clipped to the union of rounded rects (MOTION-SPEC glass group). It is not decoration. |

**Advisory (source scan, `--no-config`).** A scan of `apps/mobile/src` gave 1 advisory, `bounce-easing`, on
`styles/tokens.css:115`. It is kept (see §5).

What the detector missed, §3 covers by hand. Assessment A, in each critique, was done blind to this table.

---

## 3. Inventory by tell

### 3.1 Icon tiles (impeccable: `icon-tile-stack`; DESIGN.md: "icon tiles go, hue plates stay only for third-party logos")

| ID | Item | file:line | Screen | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| IT-1 | Welcome card rows: a 32 px tile r10 on `surface-2` before each line | `cards.css:87`, `InfoCards.tsx:42` | 05, 06 | D | One list with no tiles. The action lives in the row, so the chip row goes (see CH-1). |
| IT-2 | Empty-thread sparkles glyph, 56 px r18 tile with shadow | `chat.css:816-825`, `EmptyThread.tsx:24` | 07 | D | Drop it. The agent's own avatar or blob is the identity mark. See drafts A and B. |
| IT-3 | Thread intro plate, 52 px r16 tile with shadow, above the title of call / meet / task threads | `chat.css:73-81`, `ChatScreens.tsx:66` | drawer-opened threads | R | Remove the plate. Title, subtitle and meta are enough, with kind as a word in the meta line. |
| IT-4 | Weather icon tile, 56 px r18 | `cards.css:115`, `InfoCards.tsx:80` | 09 | D | Bare glyph at title size, or none. The temperature is the hero. |
| IT-5 | Results card row tiles, 36 px r10 | `cards.css:206` | 10 | R | Remove. Rows are title + source + chevron. |
| IT-6 | Schedule card tile, 40 px r12 | `cards.css:300`, `InfoCards.tsx:204` | 16 | R | Remove. Use a clock glyph inline in the meta line. |
| IT-7 | Approval card tile, 36 px r12; meet uses a paper-plane "send" glyph | `cards.css:332`, `ApprovalCard.tsx:82` | 08, 13 | R | Remove the tile. If a glyph stays, it must match the action (phone / video, never "send" for a meeting). |
| IT-8 | Credential card lock tile | `CredentialCard.tsx:93` | 12 | R | Remove. The provider's logo plate (K) already identifies it. |
| IT-9 | Artifact card plate, 44 px r12, coloured by kind | `cards.css:504`, `ArtifactCard.tsx:27` | 15 | D | Use a thumbnail of the artifact's first lines, or no plate. Kind becomes a word in the meta line. |
| IT-10 | Drawer thread-row tiles: white 32 px r10 on the grey drawer | `drawer.css:141`, `DrawerContent.tsx:201` | 20, 21 | D | Rows as text with time. Kind as a small leading glyph with no plate. |
| IT-11 | Explore template plates, hue-tinted 44 px r13 with a white glyph | `more.css:10-14`, `parts.tsx:44`, `ExploreScreen.tsx:125` | 22, 23 | D | Neutral glyph, or none. Hue plates are reserved for third-party logos. |
| IT-12 | Explore category pastels: 5 hues, 48 px circles with shadow | `explore.css:61-80`, `explore/CategoryRail.tsx:101-103` | 22 | D | Text segmented rail or plain text chips (choices, so chips are right). |
| IT-13 | Pre-delegate hero plate (52 px) and "필요한 연결" plates | `PreDelegateSheet.tsx:114/151` | 24 | D | Keep the provider plates (K) and drop the template plate. |
| IT-14 | Archive list kind plates (blue / green / orange, 40 px r12) | `archive/ArchiveScreen.tsx:170` | 25 | D | Same as IT-9. |
| IT-15 | Grouped-list row plates, 30 px r8, neutral, on every settings / privacy / notifications row | `ui/List.css:88`, `ui/List.tsx:67-69` | 36, 46, 47 | D | Recommend a bare 22 px glyph in `label-2`, or no glyph, in the same 30 px column. Rows stay scannable without a tile wall. |
| IT-16 | Privacy-sheet, payment-step and privacy-preview tiles | `PrivacySheet.tsx:43-46`, `payment/PaymentScreen.tsx:47-50`, `settings/PrivacyScreen.tsx:55-57` | 33, 43, 47 | R | Remove the tiles; the headings carry it. |
| IT-17 | Profile privacy card circle plate | `profile/profile.css:155-163`, `ProfileScreen.tsx:198` | 29 | D | Folds into PR-2 (the privacy card becomes a row). |
| IT-18 | Empty-state circle plates (payment, vault) | `ui/EmptyState.css:10` | 43, 49 | R | Keep a bare glyph or nothing. The sentence carries the state. |

### 3.2 Cards in cards and stacked paper (`nested-cards`)

| ID | Item | file:line | Screen | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| NC-1 | Assistant text bubble (paper with shadow), then a separate paper card for the same turn | `chat.css:157`, `cards.css:13` | 08–16 | D | Agent text as plain text on the background (no bubble), and the card as the one paper object of the turn. The user's bubble stays. |
| NC-2 | Weather card: 5 hourly tiles inside the card | `cards.css:147-180`, `InfoCards.tsx:97-99` | 09 | D | One row of hour / temp columns with no tiles, divided by spacing. |
| NC-3 | Messenger card: recessed `surface-2` quote panel inside the card | `cards.css:265-272` | 11 | R | Remove the panel background and keep the rows with author + time. |
| NC-4 | Approval preview panel ("보낼 내용") | `cards.css:352-359`, `ApprovalCard.tsx:90-92` | 08, 13 | K/R | The panel is functional (it shows exactly what is sent), so keep it. Fix the label (CP-4). |
| NC-5 | Connect sheet can/can't: two side-by-side recessed panels | `ConnectSheet.tsx:357-373` | 40 | D | One list, ✓ items then ✕ items, with no panels. Or collapse it under "권한 자세히". |
| NC-6 | Pre-delegate sheet: recessed "깽이가 이렇게 해요" and "필요한 연결" blocks, plus two stat tiles (예상 시간, 한도 사용) | `PreDelegateSheet.tsx:168-190`, `more.css` `.more-facts` | 24 | D | The stat tiles are the impeccable hero-metric tell. Use one meta line ("약 1분 · 한도 2%"). |
| NC-7 | Artifact dashboard sheet: KPI tile, chart panel and list panel inside the sheet | `archive/archive.css` (dashboard blocks) | 27 | K | The user's artifact content is rendered as authored, not chrome. Check radius tokens only. |
| NC-8 | Profile: 5 stacked paper cards (agent, quota, 7-day usage, privacy, account) | `ProfileScreen.tsx:107-264` | 29–31 | D | One grouped list for navigation, and quota as the only card. See PR-1 to PR-3. |

### 3.3 Grey text on tinted surfaces (contrast)

The contrast ratios below were computed from the tokens.

| ID | Item | file:line | Screen | Measured | Class | Direction |
| --- | --- | --- | --- | --- | --- | --- |
| GT-1 | Event-note pills: `label-2` (#6e6e73) on `fill` over `bg`, 13 px | `chat.css:211-219` | 14 | **4.07:1 light (fails AA 4.5)**; 5.9:1 dark | R | No pill. Centred footnote text on the background, which gives 4.9:1 on `#f5f5f7`. Or `label` colour on the fill. |
| GT-2 | Pre-delegate / connect / payment body copy in `label-2` inside recessed panels | `ConnectSheet.tsx:357`, `PreDelegateSheet.tsx:168` | 24, 40 | about 4.5:1, at the limit | R | Fixed by removing the panels (NC-5, NC-6). |
| GT-3 | Placeholders in `label-3` | `ui/TextField.css:59-61` | 08, 37, 40, 44 | 1.9–2.0:1 | R (minor) | Every field has a visible label. Raise to about 3:1 (see §2). |
| GT-4 | White on accent fill (every primary button) | `styles/tokens.css:21`, `ui/Button.css` | 01–04, 08–19, 24, 49 | **3.6:1** | D (token) | See §2: primary fill becomes `#0071E3`. |

### 3.4 Emoji (DESIGN.md: no emoji in UI chrome, server strings included)

| ID | Item | file:line | Screen | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| EM-1 | `eventText: "☀️ 오늘의 브리핑"` reaches the chat as an event note | `apps/server/src/schedules.ts:341` | schedule threads | R | "오늘의 브리핑". |
| EM-2 | Explore categories carry `emoji3d` ids | `api/defaults.ts:25…` | 22 | K | Ids only. They render as SVG glyphs. |

The app's `src/` contains no emoji in chrome.

### 3.5 Purple/blue gradients (`ai-color-palette`, `gradient-text`)

| ID | Item | file:line | Class | Direction |
| --- | --- | --- | --- | --- |
| GR-1 | 4-stop purple/blue gradient | `dev/Gallery.css:51` | K | Dev-only gallery, not shipped. Leave it, or swap to `--bg` if the gallery is ever shown. |
| GR-2 | Mask gradients (scroll fades) and press tints | `call/call.css:106`, `explore.css:23`, `app/Screen.css` | K | Functional. |
| GR-3 | The old 4-blob wallpaper | `three/*` | done | Replaced by the wallpaper teammate. |

### 3.6 Over-rounding and inconsistent radii

| ID | Item | file:line | Class | Direction |
| --- | --- | --- | --- | --- |
| RD-1 | 106 literal radii, 21 distinct values | see §1 #6; full list: `grep -rn "border-radius: [0-9]*px" apps/mobile/src --include=*.css` | R | Map each to `--r-sheet 38 / --r-card 24 / --r-group 20 / --r-composer 28 / --r-control 22 / --r-field 14 / --r-tile 12`, or to the 50% / 999px capsule. Inner radius = outer − padding, so the result stays concentric. |
| RD-2 | Composer radius is a literal in TSX (`radius={28}`) rather than `--r-composer` | `Composer.tsx:209` | R | Use the token. |
| RD-3 | Jump capsule `radius={20}` | `ThreadView.tsx:326` | R | Use the capsule (999px), because it is a pill-shaped control. |

### 3.7 Uniform pill chips (DESIGN.md: chips only for choices)

| ID | Item | file:line | Screen | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| CH-1 | Welcome chips repeat the 4 rows above them; one has a chevron | `InfoCards.tsx` (briefing actions) | 05, 06 | D | Remove the chips. The rows become the actions (one tap target per row). |
| CH-2 | Empty-thread: 3 identical grey suggestion pills, centred and stacked | `EmptyThread.tsx:13-20` | 07 | D | Prompt rows (left-aligned text with ↗ send affordance) in draft A, or one line of suggestion text in draft B. |
| CH-3 | Event notes rendered as pills | `chat.css:211` | 14 | R | See GT-1. |
| CH-4 | Receipt pill "승인했어요" / "보냈어요" | `cards.css:34` (`.ccard-badge`) | 13 | K | A status pill with icon + words is required by the accessibility rule. |
| CH-5 | Tool chip "N단계 · N초" | `chat.css:473-503` | 08–10 | K | Functional status. |

### 3.8 Generic icon + title + subtitle rows

| ID | Item | file:line | Screen | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| GR-R1 | Privacy sheet: 3 rows of tile, question heading and paragraph | `PrivacySheet.tsx:43-46` | 33 | R | Headings as plain bold questions with no tiles. |
| GR-R2 | Payment: 4 "steps" for a feature that does not exist yet ("이 버전에서는 결제 수단을 연결할 수 없어요") | `PaymentScreen.tsx:28-38` | 43 | D | Say once that it isn't available and what will protect it. Use no step list and no present-tense promises: either one short paragraph, or the critique's three plain sentence rows (`<ul>`) under the conditional label "결제 수단을 연결할 수 있게 되면" (payment.md P2-2 is the more specific rule). "저장된 로그인 보기" belongs to Vault. If it stays here, the sentence that mentions saved logins has to explain why. |
| GR-R3 | Settings › 정보 공개 범위: a preview card repeats the 3 toggles above with tiles | `settings/PrivacyScreen.tsx:55-57` | 47 | D | Keep the preview (it is useful) as plain two-column text with no tiles. Or fold it into each toggle's subtitle. |

### 3.9 Redundant headers and actions

| ID | Item | file:line | Screen | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| RH-1 | Agent name shown 3 times on profile and agent settings: top capsule "깽이", large title "깽이", card title "깽이" | `app/TopBar.tsx:49`, `agent/AgentScreen.tsx` | 29, 34 | D | On pushed detail screens the top capsule shows nothing, or the screen title, never the agent name again. |
| RH-2 | Schedules: "+" in the top bar and the "새 예약 만들기" button and a hint line, all for the same action | `schedules/SchedulesScreen.tsx:44/82/84` | 41 | R | Keep the top-bar "+" and the hint. Remove the button. |
| RH-3 | "초대" text capsule on chat, explore and friends top bars | `ChatScreens.tsx:25`, `ExploreScreen.tsx:34`, `FriendsScreen.tsx:33` | 05, 22, 44 | D | Invite lives in 친구 (and in the drawer). On chat and explore it is a third glass shape (see GL-1). |
| RH-4 | Usage card shows "0% 사용" and an empty bar, and the 7-day card says "기록 없음" plus a paragraph, both while there is no data | `ProfileScreen.tsx:129-160` | 29 | D | Empty-state once: "아직 쓴 기록이 없어요. 매일 새벽 4시에 한도가 초기화돼요." |

### 3.10 Decorative glows and shadows (`dark-glow`, `gpt-thin-border-wide-shadow`)

| ID | Item | file:line | Class | Direction |
| --- | --- | --- | --- | --- |
| SH-1 | Paper shadow ×11 (§1 #5) | as listed | R | Light: none (flat paper on `#f5f5f7` already separates). Dark: none, using the `surface` step. Glass keeps `--glass-shadow`. |
| SH-2 | `.cat-glyph` shadow | `explore.css:76` | R | Remove. |
| SH-3 | FAB / primary lift shadow | `ui/Button.css:76` | R | Remove. Accent fill is enough. |

### 3.11 Glass shapes (DESIGN.md Two-Layer: ≤3 visible)

| ID | Item | file:line | Screen | Count | Class | Direction |
| --- | --- | --- | --- | --- | --- | --- |
| GL-1 | Chat thread: menu + name + 초대 + composer + tab bar, plus the jump capsule when scrolled up | `TopBar.tsx:31/49/121`, `Composer.tsx:209`, `TabBar.tsx:165`, `ThreadView.tsx:326` | 05–17 | 5–6 | D | Top bar: one leading circle plus the title as text on the edge blur (no capsule); 초대 moves out. Tab bar + composer stay. The jump capsule only appears when the composer is unfocused. |
| GL-2 | More screens: menu or back + name capsule + tab bar (3), plus "+" or "초대" (4) | same | 41, 44 | 3–4 | D | Same top-bar rule. |
| GL-3 | Content runs half-legible under the top capsules | `app/Screen.css` (`.screen-edge`) | 30, 33 | n/a | K/R | The edge blur is right. Check that the large title collapses into the bar so the two don't overlap. |

### 3.12 Copy: filler, repetition and wrong semantics

| ID | Item | file:line | Screen | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| CP-1 | Welcome message is 3 paragraphs (greeting, capability list, security reassurance) | `server/src/auth.ts:150` | 05 | R | Two short lines: "안녕하세요, 하늘 님. 저는 깽이예요." plus "궁금한 걸 묻거나 귀찮은 일을 맡겨 주세요." The capabilities are already in the card, and the reassurance appears where a password is typed. |
| CP-2 | "나만의 AI 에이전트" under the agent name in the drawer | `app/Drawer.tsx:84` | 20 | R | Remove, or show status ("대기 중" / "통화 중"). |
| CP-3 | "{이름} 님의 AI 에이전트" in the agent sheet | `ChatScreens.tsx:200` | n/a | R | Remove. |
| CP-4 | Meet approval says "보낼 내용" with a "send" glyph; the action is joining a meeting | `ApprovalCard.tsx:82/91` | 13 | R | The label becomes "참여할 회의", and the glyph becomes video, or none. |
| CP-5 | The reassurance said 6+ times (§1 #3) | as listed | n/a | R/D | Keep it in three places: the credential card footnote, the Connect sheet, and the Privacy sheet. Remove it from the welcome message, the Connections note, the Profile card (which becomes a plain row "개인 정보 보호"), and the Payment steps. |
| CP-6 | Artifact card kicker "문서" above the title (`kicker-above-heading`) | `ArtifactCard.tsx:31` | 15 | R | Move to the meta line: "문서 · 방금". |
| CP-7 | Explore counts "17,166명이 맡겼어요" are seeded constants (`TEMPLATE_SEEDS[].count`, which become `seedCount`) | `server/src/explore.ts:51-147`, `ExploreScreen.tsx:121-132` | 22 | R | Hide until counts are real (`showCount = false`). PRODUCT.md: "do not fabricate". |
| CP-8 | `sparkles` as the generic "AI" glyph: task threads, the briefing schedule, memory, the recommend category, the mention hint and the 모시 이름 row | `chat/util.ts:80`, `SchedulesScreen.tsx:36`, `PrivacyScreen.tsx:62`, `AgentScreen.tsx:254`, `api/defaults.ts:25`, `Composer.tsx:236`, `AccountScreen.tsx:25`, `store.ts:578`, `templateInfo.ts:21/26/125` | 07, 20, 41, 47 | R | Use a glyph per meaning (task → checklist, briefing → sun/news, memory → bookmark, mention → at). Do not use sparkles for "AI". |
| CP-9 | Connect sheet intro is 6 lines before the form | `ConnectSheet.tsx` (intro) | 40 | D | Two lines, with the 2FA limitation as a field hint. |
| CP-10 | Phone approval: red "확인 필요" badge next to a blue primary and a blue text "취소" | `ApprovalCard.tsx:86/112/118` | 08 | R | Remove the badge, because the hold-to-confirm already signals high risk. "취소" in `label`. |

### 3.13 Colour discipline (one accent)

| ID | Item | file:line | Screen | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| CL-1 | Ticket glyphs in blue + purple | `profile/profile.css:130-135` | 29 | R | `label` glyphs with the words "기본" / "프리미엄", or the numbers alone. |
| CL-2 | Archive / artifact kind colours | `ArchiveScreen.tsx:170`, `cards.css:504` | 15, 25 | D | See IT-9 and IT-14. |
| CL-3 | Explore pastels and hue plates | see IT-11 and IT-12 | 22 | D | n/a |
| CL-4 | Hard-coded `#636366` segmented thumb (dark) | `ui/SegmentedControl.css:25` | 25 | R | Use the token. |

### 3.14 Render quality

| ID | Item | file:line | Screen | Class | Direction |
| --- | --- | --- | --- | --- | --- |
| RQ-1 | **The agent blob's silhouette is visibly aliased** on 2x/3x: `antialias: false`, `dpr [1, 1.5]` | `three/AgentBlob.tsx:175-176` | 01, 02, 18, 34 | D | The blob is the one expressive element and has stair-stepped edges at hero size. Options: MSAA on, or DPR 2 only when the canvas is ≥ 160 px (onboarding, call). Owner is the wallpaper teammate (`src/three/*`); flagged. |
| RQ-2 | The Dynamic Island level shows "-----" when there is no audio (fake device) | `app/DynamicIsland.tsx` | 19 | K | Correct for silence. Check that the dashes read as a level, not as text. |

---

## 4. Keep (intentional)

- **Third-party logo plates** (KakaoTalk, Slack, Discord, Telegram, LINE, Instagram) in Connections, the Connect sheet,
  Vault and the pre-delegate "필요한 연결". This is brand recognition, not decoration. DESIGN.md exempts it.
  - Minor: check the hues against each brand (Slack is aubergine, not magenta; Discord is `#5865F2`).
- **The agent blob and avatar dot** in the agent hue. This is the one expressive element.
- **The red end-call button**, the only colour on the call overlay.
- **Status pills** with icon + words (accessibility: never colour alone).
- **The approval preview panel.** It shows exactly what will be sent (principle 2).
- **The tool chip "N단계 · N초"** (status visibility).
- **Fake carets** in Spotlight and the phone keypad (`ui/Spotlight.css:98`, `profile/phone.css:97`). They are
  functional. The detector's `blinking-cursor` rule does not apply to a real input caret.
- **Spinners** (`chat-spin`, `btn-spin`, `call-spin`, `conn-spin`). They show busy state, are loop-gated
  (`data-loop="busy"`) and are honoured by reduced motion.
- **Segmented controls and toggles.** These are iOS-native.
- **Mask gradients** for scroll edges.

## 5. Motion audit against MOTION-SPEC (nothing to remove)

| Item | Where | Verdict |
| --- | --- | --- |
| Spring tokens (`linear()` morph/press/snap/camera/lead/trail/fade) | `styles/tokens.css` | K: the core of the brand motion. |
| `--ease-press` fallback `cubic-bezier(0.3, 1.25, 0.5, 1)` (overshoot) | `styles/tokens.css:115` | K. Detector `bounce-easing` is advisory. The overshoot is the press spring's own (MOTION-SPEC §2), used only where `linear()` is not supported. |
| Avatar breathing 3.2 s, 1 → 1.02 | `ui/Avatar.css:5-19` | K: MOTION-SPEC §8.11. Opt-in, only on stage, visible and recent input. |
| Chip stagger 30 ms on `snap` | `EmptyThread.tsx` | K: MOTION-SPEC stagger. The drafts keep it on the new prompt rows. |
| Spinners, carets | see §4 | K |
| Tab-bar minimise, re-entrance or fade on return | n/a | Not present. Keep it that way (the user rejected them). |

## 6. Notes for the wallpaper teammate

- RQ-1 (blob aliasing) is in `src/three/AgentBlob.tsx`, which you own.
- The drafts assume the landed background: `--bg` plus one top-edge radial light, `--wp-light-mix` 10% / 12%. The
  drafts import `three/Wallpaper.css` tokens through `tokens.css`, so a later tweak flows into them.

## 7. Where each item goes

- Every **R** item can be handed straight to the screen teams. None of them changes a flow.
- Every **D** item is covered by the per-feature critiques in `critique/` and gets an A/B draft in
  `docs/design/drafts/<feature>/`.
- The first draft, 빈 대화와 제안, covers IT-1, IT-2, CH-1, CH-2, NC-1 and CP-1.
