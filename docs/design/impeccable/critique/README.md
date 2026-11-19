# Critiques by feature (2026-11-12)

These critiques follow the impeccable `critique` method (github.com/pbakaus/impeccable, Apache-2.0).

- **Assessment A** was a design review done in four isolated sub-agents (critique-a1 to a4). Each worked from 200
  screenshots (Chrome and WebKit, light and dark, at 390×844) plus the source, with PRODUCT.md and DESIGN.md as the
  brief.
- **Assessment B** was the impeccable detector, run over CDP on every rendered screen by design-director.
- Each file ends with an A × B synthesis.
- Screenshots are in `../shots/`. Cross-feature tells are collected in `../slop-inventory.md`.

| Feature | File | Score | Band | P0 | P1 (A) | P1 added by B |
| --- | --- | --- | --- | --- | --- | --- |
| 채팅 | [chat.md](chat.md) | 27/40 | Acceptable | 0 | 3 | accent fill 3.6:1 |
| 빈 대화와 제안 | [empty-thread.md](empty-thread.md) | 27/40 | Acceptable | 0 | 2 | (none) |
| 온보딩 (Persuade) | [onboarding.md](onboarding.md) | 23/32 (72%) | Good | 0 | 1 | CTA 3.6:1 |
| 음성 통화 오버레이 | [voice-call.md](voice-call.md) | 28/40 | Good | 0 | 0 | accent fill 3.6:1 |
| 전화 대행 | [phone-delegation.md](phone-delegation.md) | 24/40 | Acceptable | 0 | 3 | 전화 걸기 3.6:1 |
| 회의 참여 | [meeting.md](meeting.md) | 24/40 | Acceptable | 0 | 2 | accent fill 3.6:1 |
| 서랍 | [drawer.md](drawer.md) | 26/40 | Acceptable | 0 | 0 | Spotlight top row 3.6:1 |
| 둘러보기 | [explore.md](explore.md) | 25/40 | Acceptable | 0 | 2 | sheet CTA 3.6:1 |
| 보관함 | [archive.md](archive.md) | 25/40 | Acceptable | 0 | 1 | (none) |
| 연결 | [connections.md](connections.md) | 25/40 | Acceptable | 0 | 1 | (none) |
| 일정 | [schedules.md](schedules.md) | 27/40 | Acceptable | 0 | 1 | (none) |
| 나의 모시 | [my-mosi.md](my-mosi.md) | 26/40 | Acceptable | 0 | 1 | (none) |
| 결제 | [payment.md](payment.md) | 19/28 (68%) | Acceptable | 0 | 0 | (none) |
| 친구 초대 | [invite-friends.md](invite-friends.md) | 28/40 | Good | 0 | 1 | (none) |
| 설정 | [settings.md](settings.md) | 26/40 | Acceptable | 0 | 2 | vault CTA 3.6:1 |

Where a total is out of less than 40, the method allowed some heuristics to be scored n/a, so the total is renormalised.
The reason is given in each file.

**Every critique raises the same problems.** Fixing these once in shared components lifts all 15 screens:

1. **Icon plates.** Tiles appear beside or above every title and row. The detector misses them because they are
   `span`s. See inventory §3.1.
2. **Nested paper and stacked cards.** Bubbles sit on top of cards, and recessed panels sit inside cards.
3. **Repeated reassurance.** The "기기에서 암호화돼요 · 모시도 볼 수 없어요" message appears 5–8 times across the app.
4. **More than three glass shapes.** The chat screen shows up to 6; other screens show 4 when a top-bar action is present.
5. **Primary button contrast** (found by B). White text on `#0A84FF` is 3.6:1. The proposed fix is to use the existing
   `--accent-text` `#0071E3` as the button fill, which gives 4.7:1. This is a token decision.
6. **Skipped heading levels** (found by B). `SectionLabel` renders `<h3>`, which skips h2 on every More screen. One-line
   fix in `screens/more/parts.tsx:93`.
