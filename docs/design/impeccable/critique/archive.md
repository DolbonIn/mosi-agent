Method: dual-agent (A: critique-a3 · B: impeccable detector over CDP, run by design-director)

# Critique: 보관함 (Archive: artifacts, media, artifact sheet)

2026-11-12 · Mode: Operate · Screens: `25-archive-artifacts`, `26-artifact-sheet-document`, `27-artifact-sheet-dashboard`, `28-archive-media-empty` · Chrome + WebKit, light + dark, 390×844

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Segmented control, still placeholders, copy loader → "복사했어요" and the delete banner all report real state. The dashboard's accent bar is a "selected" state that shows no value at rest. |
| 2 | Match System / Real World | 2 | The segment is called "아티팩트", a developer and AI-tool word, while the empty copy on the same tab says "문서" and "사진이나 파일". "대시보드" and "미디어" lean the same way. |
| 3 | User Control and Freedom | 3 | Sheets close by ×, drag or scrim. Delete takes a hold or two taps. Segments switch by tap or swipe. |
| 4 | Consistency and Standards | 2 | The media empty state has two upload controls (button + FAB). The sheet title is repeated as the document's H1. Delete's second-tap label is generic here ("실행돼요") but specific in 일정. Radii are literals. |
| 5 | Error Prevention | 3 | Two-step delete. Upload checks size and type before sending, and says why. |
| 6 | Recognition Rather Than Recall | 3 | Titles and dates carry recognition. The previews that should help scanning run headings and items together into one unreadable string. |
| 7 | Flexibility and Efficiency | 2 | Swipe between segments, share and copy. No search, sort or filter for an archive that only grows. |
| 8 | Aesthetic and Minimalist Design | 2 | Hue-coded icon plates on every card. The dashboard is the hero-metric template inside three recessed panels. The empty-state glyph sits on a plate. Paper casts a shadow in light mode. |
| 9 | Error Recovery | 3 | "다시 불러오기" next to the server message. A dashboard that fails to parse falls back to the raw text with a plain note. Upload errors name the fix. |
| 10 | Help and Documentation | 2 | The artifact empty state teaches by action. The media empty state contradicts itself ("대화에서 + 버튼으로" above a button on this screen). Nothing explains what lands here. |
| | **Total** | **25/40** | **Acceptable** |

## Design Specificity Verdict
**LLM assessment.** The skeleton is the iOS standard for a files or notes tab: a large title, a full-width segmented control, a card list, a sheet per item, and a 3-column media grid. That is the right skeleton for Operate. The trouble is what has been painted on it. The per-kind colour plates (blue document, green chart, orange check) and the dashboard's big number in a grey tile above a bar chart and a "top N" list are category-interchangeable. Any SaaS dashboard or AI-notes app ships exactly these. The one authored part is the document sheet. A real meeting record (참석, 정한 것, 할 일 with task circles, 메모), set in Hangul with generous leading, is what 모시 actually produces from a Meet or a chat, and it reads like the product. The archive is the "record of what the agent did" (PRODUCT.md, principle 1). Right now the list reads like a file browser with coloured badges, not like a record.

**Deterministic scan.** Pending: Assessment B is joined by design-director.

## Overall Impression
The bones are good and the behaviour is careful. Every sheet morphs from its source, placeholders are still, errors sit next to the control that failed, and actions confirm only after the server answers. The surface carries most of the generated-UI residue the Direction names: icon tiles, a card inside a card, a hero-metric tile, a duplicated add action and a shadow on paper. The biggest opportunity is the artifact card. Make it read as a record: title, what kind and when, and a preview you can actually read, with no badge doing the talking.

## What's Working
- **Sheet craft.** The card → sheet morph keeps the source in place. 복사하기 runs loader → check and says "복사했어요" only after the copy resolves (`ArtifactSheet.tsx:113`), and its grid keeps 공유하기 still while 복사하기 contracts (`archive.css:181-192`). This is the organic motion the user wants kept, tied to real state.
- **The document renderer is the product's voice.** Markdown at 17 px / 1.6 with global `keep-all` (`styles/base.css:24`), real task rows, and bold dates inside running text (`26`) make a meeting summary feel like a record a person can act on.
- **Honest edge states.** A dashboard that fails to parse shows the original with "대시보드 형식을 읽지 못해서 원본 그대로 보여 드려요." (`ArtifactSheet.tsx:135`). Upload validation names the problem and the recovery ("10MB보다 큰 파일은 올릴 수 없어요. 크기를 줄여서 다시 올려 주세요.", `UploadSheet.tsx:21`).

## Priority Issues

**[P1] Artifact cards lead with a colour badge and end with an unreadable preview**
- **What:** Each card opens with a 40 px hue plate (blue 214 / green 160 / orange 32) carrying a white glyph. The kind is then written again in the meta line ("문서 · 어제 수정"). The preview flattens the Markdown and joins it with spaces. Headings run into sentences ("…다은 · 42분 정한 것 출시일은 12월 2일로 확정…"), the first words repeat the title ("11월 12일 주간회의…", "이사 준비 이사 업체…"), and the checklist becomes one string with no separators ("이사 업체 견적 3곳 전입신고 날짜 정하기 인터넷 이전 신청…").
- **Why it matters:** The plate is the loudest thing on the card, louder than the title, and it says what the meta line already says. That is the Direction's first change ("Icon tiles go") and DESIGN's Don't ("Don't put an icon in a rounded-square tile next to … a line of text"). The preview is the one aid for telling three similar records apart. As written it costs more to read than opening the sheet.
- **Fix:** Remove the `<Plate>` from the card head. The title (17/600) starts the card, and the meta line "문서 · 어제 수정" stays in `--label-2` footnote. If a glyph is wanted, a 15 px `--label-2` icon inline before "문서" is the ceiling. Rebuild `previewOf`. Drop a leading heading when the title starts with it, and join the remaining lines with " · " instead of " ". For a checklist, lead with the count derived from its task items, then the first open items: "6개 중 0개 완료 · 이사 업체 견적 3곳 · 전입신고 날짜 정하기". The two-line clamp stays.
- **Evidence:** `25` (all engines and themes). `ArchiveScreen.tsx:170` (Plate), `ArchiveScreen.tsx:147-154` and `:153` (join with spaces), `Markdown.tsx:260-277` (`stripMarkdown` drops the structure), `ArtifactSheet.tsx:17-22` (kind hues), `parts.tsx:44-55`, `more.css:10-16`.

**[P2] The dashboard sheet is the hero-metric template inside three nested panels, and its chart says nothing at rest**
- **What:** In `27` the sheet (paper) holds three `--surface-2` panels: a stat tile (small label, big number, delta), a "주별 지출" chart panel and a "많이 쓴 곳" list panel. The 4주 bar is accent blue because the chart selects the last bar by default, but no value is shown, so the blue is unexplained. The chart gets no unit, so pressing a bar shows a bare number ("312,000", not "312,000원"). The list puts the amount inline with the name ("배달의민족 182,000원"), so the amounts don't align.
- **Why it matters:** craft-floor names the hero-metric template and nested cards as category defaults ("nested cards are always wrong"). DESIGN's "No card inside a card" and "Flat Paper" rules ask for rows and dividers inside the one surface. The accent at rest spends the screen's one blue on a mark that communicates nothing. Weekly spend, the reason the chart exists, can only be read by discovering a press gesture.
- **Fix:** Drop the three panel backgrounds (`.dash-stat`, `.dash-block`). Sections sit flush on the sheet paper, separated by `--section` (24 px) and a hairline (`box-shadow: inset 0 1px 0 var(--separator)`). Keep the stat's type: label footnote `--label-2`, value title2 600 tabular, delta footnote. Do not box it. In `Dashboard.tsx`, derive the unit from the first stat's `parseStat(...).suffix` ("원") and pass it to `BarChart` as `unit`. Show the selected bar's value as a static caption beside the block title ("4주 · 312,000원", subhead `--label-2`, tabular), so the accent has a meaning. Split each list item's trailing amount (`/(.*?)\s+([\d,.]+\s?원)$/`) into a right-aligned tabular column. The bars' first-visible rise and the Odometer roll stay as they are.
- **Evidence:** `27` (chromium and webkit, light and dark). `Dashboard.tsx:104-110` (stat tiles), `Dashboard.tsx:113-117` (`BarChart` without `unit`), `Dashboard.tsx:121-130` (list), `archive.css:399-410` (r16 tile), `archive.css:436-443` (r18 panel), `ui/BarChart.tsx:76` (default selection = last bar).

**[P2] Empty media offers two upload controls and two contradictory instructions**
- **What:** `28` shows "아직 올린 사진이나 파일이 없어요". The body says to send from chat ("대화에서 + 버튼으로 사진이나 파일을 보내 보세요."). Below it sits a "+ 사진이나 파일 올리기" button, and a glass "+" FAB floats bottom-right. All three paths lead to the same place, or close to it.
- **Why it matters:** The person has to work out which of three instructions is the real one, so the empty state no longer offers "one real action" (MOTION-SPEC §8.14). The FAB is also a fourth glass shape on screen (menu, name capsule, FAB, tab bar), past the "≤3 visible glass" rule.
- **Fix:** Hide the FAB while the media list is empty: `visible && seg === "media" && media.data.length > 0` at `ArchiveScreen.tsx:101`. The empty-state button stays the one action, and its picker sheet keeps morphing out of the button (`openUploadPicker(e.currentTarget)`). Make the body describe both paths truthfully (`sdui.ts:31`): "여기에서 올리거나 대화에서 + 버튼으로 보내면 여기에 모여요." With items on screen, the FAB remains the only add path. See Questions for whether it earns the fourth glass shape.
- **Evidence:** `28` (all engines and themes). `ArchiveScreen.tsx:101`, `ArchiveScreen.tsx:191-202`, `UploadSheet.tsx:163-180` (glass FAB), `apps/server/src/sdui.ts:31`.

**[P2] The document sheet says its title twice and boxes its tasks**
- **What:** The sheet title is "11월 12일 주간회의의 회의록", and the first line of the body is an H1 "11월 12일 주간회의". `withoutTitle` only strips an exact match. Between them sit the meta line and two action capsules, so the record starts a third of the way down the sheet. "할 일" is a recessed `--surface-2` panel (r16) inside the sheet.
- **Why it matters:** The document is the record (principle 1), and in `26` it starts below title, meta, actions and a second title. The recessed task panel is the card-inside-a-card the Direction removes.
- **Fix:** In `withoutTitle`, also drop a leading `#`/`##` heading when the normalised title starts with it (`norm(title).startsWith(norm(heading))`). Move 공유하기 / 복사하기 below the body, into the bottom section above the separator, so the order is title → meta → document → actions → delete. `.md-tasks` loses its background and radius. Task rows sit on paper with the existing hairlines and circle boxes. Pass `confirmLabel="한 번 더 누르면 지워요"` to the delete `ConfirmButton`, to match 일정.
- **Evidence:** `26` (all). `ArtifactSheet.tsx:26-31`, `ArtifactSheet.tsx:103-116`, `ArtifactSheet.tsx:145-155`, `archive.css:585-595`.

**[P2] "아티팩트" is developer vocabulary at the top of a consumer tab**
- **What:** The segmented control reads "아티팩트 | 미디어". The same tab's empty copy says "아직 생성한 문서가 없어요" and "사진이나 파일".
- **Why it matters:** PRODUCT.md's users are "not technical" and expect the app to "talk like a capable person, not like software". "아티팩트" is an AI-tool term, and the screen's own copy already uses the plain words.
- **Fix:** Segments "문서 | 사진·파일" (`sdui.ts:27-28`). The empty title becomes "아직 만든 문서가 없어요" ("생성한" is translationese). Kind labels keep "문서 · 체크리스트 · 표". "대시보드" could become "요약", but that is optional.
- **Evidence:** `25`, `28`. `apps/server/src/sdui.ts:26-31`.

## Cognitive Load
- **Checklist failures (1, low):** *Visual hierarchy.* On the list, the coloured plate outranks the title. On the dashboard, the accent bar draws the eye and carries no information.
- **Decision points with >4 visible options:** none. The document sheet offers four (공유하기, 복사하기, 보관함에서 지우기, ×), which is at the limit and fine.

## Emotional Journey
Opening 보관함 feels tidy and calm: three cards and a quiet segmented control. The first valley is reading the cards. The previews make you work, and the three badges make the list feel like a template. Opening a document is the peak, because it looks like a real record with real decisions. The dashboard is a second valley: a big number, then grey boxes and a blue bar that won't say how much. The end of every sheet is a pink "보관함에서 지우기", so by the peak-end rule the last thing each sheet shows is the destructive action. That is acceptable because it is two-step, but the neutral actions (share, copy) belong closer to it than to the title.

## Persona Red Flags
**Alex (Power User):** No search, sort or filter in an archive that only grows. Finding last month's 회의록 means scrolling. No bulk delete. The dashboard's weekly values need a press-and-drag on each bar (keyboard ←/→ exists on desktop, which is good).

**Sam (Accessibility):** The accent "selected" 4주 bar is the only visual emphasis in the chart, with no visible value. VoiceOver gets the hidden table, but low-vision users get colour only. The archive card's `aria-label` reads kind, title and date but not the preview, so screen-reader users lose the one scanning aid sighted users have. That is fine once the preview is readable. Add it as the description.

**Casey (Distracted Mobile):** In `28` the main action is mid-screen, and the FAB is in the thumb zone. Two targets, one job. Share and copy sit at the top of a tall sheet, out of thumb reach. Moving them to the bottom (P2 above) also fixes reach.

**Project persona: Between-errands delegator "지수"** (from PRODUCT.md Users: non-technical, one-handed, short bursts, expects the agent to talk like a person). *Red flags:* "아티팩트" means nothing to her, so she wonders whether the agent's meeting summary is under 아티팩트 or 미디어. The checklist preview is a wall of words she can't skim at a red light. "대시보드" for "11월 지출 정리" reads like work software.

## Minor Observations
- Light-mode cards cast the incumbent two-layer shadow (`ui/Card.css:9`). The Direction wants flat paper (value separation on `#f5f5f7`). Dark already uses the hairline.
- Literal radii off the token scale: `.dash-stat` 16, `.dash-block` 18, `.md-tasks` 16, `.arc-tile__icon` 10, `.arc-pick__file` 18, `.arc-pick__thumb` 10, `.md-code` 6, `.md-pre` 14 (`archive.css:405, 438, 589, 132, 344, 356, 521, 529`). Map them to `--r-tile` (12) / `--r-group` (20) / `--r-field` (14) / capsule.
- Media file tiles repeat the icon-tile pattern (34 px r10 `--fill`, `archive.css:127-136`). A file glyph at text size above the name is enough.
- The empty-state glyph sits on a 64 px `--fill` circle (`ui/EmptyState.css:10-19`). This is listed in the Direction ("empty-state glyph"). It also pushes the content down.
- The artifact empty state's CTA is primary blue ("깽이에게 문서 만들어 달라고 하기"), while the media one is neutral. That is fine as the screen's one accent, but the two empty states should agree.
- `Delta` uses `arrow-up` for up but `chevron-down` for down (`Dashboard.tsx:62`). Use one glyph family.
- "주간회의의 회의록" (double 의) is fixture data, but the title-vs-H1 duplication it reveals is code (P2 above).
- The upload picker's note hard-codes "모시에게" instead of the agent name (`UploadSheet.tsx:157`).

## Engine and Theme Differences
- **WebKit vs Chromium measure:** the empty-state body wraps at about 177 px in WebKit and about 220 px in Chromium (`28`), because `max-width: 28ch` (`ui/EmptyState.css:29`) resolves differently per engine. For Hangul, an em-based measure (e.g. `max-width: 17em`) is predictable in both.
- **WebKit line break:** in `26` the memo breaks between `"알림이 너무 많다"` and `는` in WebKit, splitting the particle from its quote. Chromium keeps them together. Wrapping the quoted phrase with its particle in a `nowrap` span is one option, or accept the break.
- **Dark:** the segmented thumb becomes a mid-grey fill and reads heavier than the light-mode white thumb, which is fine. Plates darken (60 % / 46 %) and still dominate. The dark avatar dot in the name capsule sits on a white disc, which is shared top-bar chrome and not specific to 보관함.
- **Tab droplet:** nearly invisible in chromium-light (white on near-white glass). It is visible in webkit-light and in dark. This is shared chrome. Noted only.

## Questions to Consider
- Is "아티팩트" a deliberate parity with the original Pickle app? If so, is parity worth a word the users don't know, when the tab's own copy already says "문서"?
- What would the archive card look like if it said where the record came from ("11월 12일 회의에서", "대화에서")? That is the provenance that makes it the agent's record and not a file. It is data the thread already has.
- Once the media grid has items, does the glass FAB earn the fourth glass shape? Or should upload live in the empty top-bar slot, which is the same count but in the standard place, or as a neutral capsule at the head of the grid on paper?
- Does a spending dashboard need a chart at all at four points, or would four rows ("1주 280,000원 …") with the current week bold say more with less?

## Assessment B: Detector
Run by design-director: `impeccable detect --cdp 9333 --json` on each rendered screen (Chrome light, 390×844, logged-in throwaway account). The engine was verified against `engine-checksums.txt`; nothing was installed and no hooks were enabled. Screens: 25, 26, 27, 28.

| Rule ID | Hits | Screens | Evidence | Verdict |
|---|---|---|---|---|
| `skipped-heading` | 3 | 25, 26, 27 | <h1> "보관함" followed by <h3> "11월 12일 주간회의 회의록" (missing h2) | **True positive.** `SectionLabel` renders `<h3>` straight after the page `<h1>` (`screens/more/parts.tsx:93`), so VoiceOver's heading rotor skips a level. Make it `h2`. |
| `organic-clip-path` | 4 | 25, 26, 27, 28 | clip-path: path() with 12 curve segments | **False positive.** This is the Liquid Glass group union, the glass layer clipped to the union of rounded rects (`ui/Glass.tsx:234`). It is intentional, not an organic blob. |

**No AI-tell rules fired** on these screens (`icon-tile-stack`, `nested-cards`, `side-tab`, `gradient-text`, `ai-color-palette`, `hero-eyebrow-chip`, `kicker-above-heading` and the rest). The detector's DOM heuristics don't match this app's shapes: its plates are bare `span`s and its nested panels are recessed `surface-2`, not bordered cards.

**Synthesis (A × B)**
- **Agree:** nothing overlaps directly. A's placeholder notes concern copy, not contrast.
- **B caught, A missed:** **[P2] Skipped heading level**: `<h1>` 보관함 goes straight to `<h3>` artifact titles.
- **A caught, B missed:** colour kind plates; run-on previews; the dashboard hero-metric template inside nested panels; two upload controls and a 4th glass shape (the FAB).
- **False positives:** `organic-clip-path`.

Provenance: Assessment A ran in an isolated sub-agent that never saw this table. The parent (design-director) saw the detector output before A finished, so this synthesis, though not A's scores, may be anchored by it. A's heuristic scores above are unchanged; the B-only issues are added here as extra priority items, not folded into the scores.

## Run Notes
- Looked at: chromium-light, chromium-dark and webkit-light for `25`–`28`. Spot-checked webkit-dark `27`. Read `ArchiveScreen.tsx`, `ArtifactSheet.tsx`, `Dashboard.tsx`, `Markdown.tsx` (`stripMarkdown`), `MediaGrid.tsx`, `UploadSheet.tsx`, `archive.css`, `parts.tsx`, `more.css`, plus `ui/BarChart.tsx`, `ui/EmptyState.css`, `ui/Card.css` and `apps/server/src/sdui.ts` for the segment and empty copy.
- Limits: stills only. No motion findings: the morphs, the chart rise and the Odometer are judged from source against MOTION-SPEC and are kept in every fix. Artifact contents are fixture data. The media grid with items, the media preview sheet and the upload picker were not captured, so they were judged from source only. Detector not run (isolation rule). No servers or browsers started, and nothing under `apps/` was modified.
