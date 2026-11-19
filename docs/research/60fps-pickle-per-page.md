# 60fps.design 전수 조사 → 모시 페이지별 개선안

- 작성일: 2026-11-11 · 대상: `apps/mobile`(모시, 피클 재구축, Liquid Glass + 유기적 스프링) · 구속 문서: `docs/design/MOTION-SPEC.md`
- 입력: 60fps.design 라이브(오늘), 1차 조사(2026-10-05 `60fps-liquid-glass-research.md`), 2차 기록(2026-10-14 집계), apple-hig 스킬(`SKILL.md`, `react-console-and-magazine.md`, `organic-motion.md`, `patterns.md`, `components-2.md`, `raw/generative-ai.md`), REA 보고서와 실제 앱 화면 5장(개인 정보는 옮기지 않고 기능·구조만 기술), 현재 빌드 QA 캡처.
- 타이밍 표기: **실측**(오늘 라이브 페이지에서 측정) / **코드**(60fps Snippets의 SwiftUI 리터럴) / **추정**(영상 프레임 차분, 상한). 사례 ID: `A###` App Sites · `M###` Motion · `S####` Shots · `N###` Snippets. 링크는 각 ID에 걸려 있고 부록에 전체 목록이 있다.

## 0. 요약 — 영향 × 비용 순 상위 15개 변경

> 영향: 상(신뢰·핵심 흐름·매 세션) / 중 / 하. 비용: S(하루 이내) / M(2–3일) / L(1주 이상). 정렬은 "영향 ÷ 비용"이 큰 순.

| 순위 | 변경 | 화면 | 영향 | 비용 | 근거 | §4 |
|---|---|---|---|---|---|---|
| 1 | **Dynamic Island idle을 정지시키고 상태 어휘 하나로 통일**(듣는 중·생각 중·"카카오톡 읽는 중"·승인 필요·완료·오류·오프라인). 레벨 막대는 실제 음량/토큰 속도만 | 전체 | 상 | S | HIG generative-ai, [S2043](https://60fps.design/shots/monogram-pulse-sweep-chat-response-reveal-interaction) [S2047](https://60fps.design/shots/monogram-pulse-calendar-connect-reveal-interaction), QA v4-chat(가짜 파형) | 0-4 |
| 2 | **탭 전환에서 나감·전체 화면 블러 제거**: 이전 페이지 즉시 제거, 새 페이지 opacity 180ms + 6px rise | 전체 | 상 | S | react-console 레시피, [A051](https://60fps.design/appsites/aave-tab-scale-interaction) ≈183ms(추정), QA v3-midswitch 빈 프레임 | 0-1 |
| 3 | **화면당 강조색 1개**(초대·부탁하기·통화·FAB 중립, 글로우 제거) | 전체 | 중 | S | MOTION-SPEC §0, §6-1 반면교사 7건 | 0-3 |
| 4 | **전송 → 멈추기 모핑 + 첫 토큰 전 타임라인**(0–150ms 없음 → 150ms 정지 자리표시 → 1s 상태 문구 → 2s 경과 시간) | 채팅 | 상 | S | HIG generative-ai, [S1848](https://60fps.design/shots/eimi-generating-card-preview-morph-pop-scale-in-sheet-animation) Stop→Done, organic-motion §9.1 | 2-1, 2-2 |
| 5 | **press를 같은 프레임에**(CSS 클래스, React 상태 경유 금지) + 낙관적 말풍선 같은 프레임 | 전체 | 상 | S | §5-1, 60fps 자체 hover 150–200ms(10-05 실측) | 0-6 |
| 6 | **도구 칩 = 실제 도구 이름 + 완료 후 "N단계 · 12초" 요약 + 펼치면 출처** | 채팅 | 상 | M | [S2047](https://60fps.design/shots/monogram-pulse-calendar-connect-reveal-interaction), [S0067](https://60fps.design/shots/arc-search-ai-generation-loader), [N014](https://60fps.design/snippets/see-all-menu-expand-interaction) spring(.36,.90) | 2-5 |
| 7 | **승인 카드 위험도 3단계**(낮음 = 실행 취소 / 중간 = 보낼 내용 전문 미리보기 / 높음 = 길게 누르기 1.2s와 같은 자리 2단계 탭 동시 제공) | 채팅 | 상 | M | [N022](https://60fps.design/snippets/delete-to-confirm-button-interaction) [N029](https://60fps.design/snippets/cancel-button-expand-to-confirm-interaction) [N007](https://60fps.design/snippets/hold-to-commit-button-interaction) [S1634](https://60fps.design/shots/fuse-delete-wallet-sheet-checkbox-interaction), HIG "permission before irreversible" | 2-6 |
| 8 | **둘러보기 카드 → "맡기기 전 확인" 시트**(필요 연결·시간·한도) → 시트가 컴포저로 수축하며 전송 | 둘러보기 | 상 | M | [S2126](https://60fps.design/shots/plasma-duo-style-bottom-sheet-open-interaction) Plasma(567–933ms, 추정), [S1710](https://60fps.design/shots/wabi-chat-suggestion-swipe-cards-carousel-interaction) Wabi, [A070](https://60fps.design/appsites/jace-thumbnail-hero-transition) | 4-2, 4-3 |
| 9 | **브리핑 카드를 항목 행 + 빠른 답 칩으로 구조화**(본문 속 질문에 입력 없이 답) | 채팅 | 상 | M | [S2042](https://60fps.design/shots/monogram-rich-chat-response-card-swipe-interaction) Monogram, REA(실제 앱은 긴 글·버튼 없음) | 2-4 |
| 10 | **채팅에서 탭 바 최소화**(현재 탭 원 하나 + 같은 줄 컴포저), 하단 크롬 17% → ≤ 10% | 채팅 | 중 | M | HIG tab bars(iOS 26 minimize), [S2099](https://60fps.design/shots/netflix-poster-reflection-on-bottom-tabs-interaction) [S2041](https://60fps.design/shots/monogram-keyboard-icon-morph-to-chat-input-interaction) | 2-9 |
| 11 | **캐릭터 숨쉬기 0.2Hz → 3.2s 주기·진폭 ≤ 2%**, 무입력·화면 밖 정지, 포스터 먼저 R3F 나중 | 실행 | 중 | S | organic-motion(4–6s 대역 회피), §5-2 | 1-1, 1-2 |
| 12 | **가입을 소셜 로그인 우선 2단계로**, 권한은 처음 필요할 때 | 실행 | 중 | M | REA(Stytch: Google·Kakao·Line·전화), HIG onboarding, [S1375](https://60fps.design/shots/family-dynamic-sheet-morph-interaction) | 1-3, 1-6 |
| 13 | **빈 상태마다 실제 행동 1개**(컴포저에 예시 문구를 넣고 이동), 빈 채팅 제안 칩 3개 | 채팅·보관함·예약 | 중 | S | [S0780](https://60fps.design/shots/family-approvals-empty-state-floating-lock-animation) [S1972](https://60fps.design/shots/claude-code-empty-state-mascot-illustration-animation) [S1710](https://60fps.design/shots/wabi-chat-suggestion-swipe-cards-carousel-interaction) | 1-5, 5-2, 11-5 |
| 14 | **드로어 = 대화 목록 전용**(탭 바 목적지 중복 제거) + 스레드 상태("승인 대기") 고정 | 드로어 | 중 | S | HIG tab bars, §3-0 | 3-1, 3-3 |
| 15 | **설정 기본값 "시스템 따름" + 볼트 즉시 가림(`visibilitychange`)** | 설정·볼트 | 중 | S | HIG settings, [N011](https://60fps.design/snippets/hide-sensitive-number-interaction) | 12-1, 8-1 |

**스프링 표는 바꾸지 않는다.** 오늘 60fps Snippets 32건의 코드에 나온 컴포넌트 스프링은 t90 116–241ms, ζ .82–.94이고, 우리 `snap`·`lead`·`trail`·`morph`가 이 범위 안에 있다(§2-3). 예외인 N023(오버슈트 3.7%)만 피한다.

**10-14 이후 신규**: App Sites 3건(A094–A096, Apple 마케팅 스크롤 — 관련성 낮음), Snippets 12건(N021–N032 — 확인 버튼·드롭다운 모핑·숫자 입력 등 직접 쓸 값), Shots 약 30건(S2110–S2140 — 카드→시트, 서버 완료 연동, 확인 시트), Motion 0건.

## 1. 조사 범위와 방법

### 1-1. 오늘(2026-11-11) 60fps.design에 있는 것 — 전수 집계

| 섹션 | 오늘 집계 | 10-05 1차 조사 | 10-14 2차 조사 | 10-14 이후 신규 | 상세 열람(이번) | 근거 |
|---|---|---|---|---|---|---|
| App Sites `/appsites` | **95건**(카운터 "96", #048 결번 유지) | 87 | 92 | **3건** (A094·A095·A096, 영상 업로드 2026-10-20) | 신규 8/8 (A089–A096) + 관련 영상 5개 프레임 분석 | sitemap.xml 95 경로 = 목록 HTML 번호 096→087, 1차 목록과 diff |
| Motion `/motion` | **83건** + 태그 페이지 124 | 83 | 83 | **0건** | 0 (1차 조사 83/83 열람 결과 재사용) | sitemap 83 경로가 1차 목록과 100% 동일 |
| Snippets `/snippets` (SwiftUI 재현 코드) | **32건** | — | 20 | **12건** (N021–N032, 영상 업로드 2026-10-19) | **32/32** + 9건 코드 재열람 | 상세 페이지 번호·업로드일, 무료 공개 코드 구간의 `spring(response:dampingFraction:)` 값 |
| Shots `/shots` (iOS 앱 모션) | **2,124 상세 경로**(+ 목록 `/shots/watch`, 카운터 "2140" — 결번 16개) + 필터 108종 | ≈2,100 | 2,094 | **≈30건** (S2110–S2140, 경계 ±1–5, 추정) | **672건** (AI·채팅·음성·글래스·시트·탭·토스트·로딩·보안 입력·검색·빈 상태·온보딩·차트·연결·공유 키워드 + 최신 60건) | sitemap 2,124 경로(최신순), 상세의 번호·설명·카테고리·태그·VideoObject |
| Apps `/apps` | 499 | 492 | — | +7 | 0 | 내비 카운터 |
| Storyboards | 67 (무료 5) | 67 | 67 | 0 | 0 | 내비 카운터 |
| Glossary | 85 | 85 | — | 0 | 0 | sitemap |
| 기타 | MCP · Jobs · Mockup · PRO · Why | | | | 0 | sitemap |

- **"10-14 이후 신규" 판정**: App Sites는 상세 영상 ID(gumlet ObjectId 앞 4바이트 = 업로드 시각)로 확정 — A089–A093은 2026-10-08 업로드(10-14 조사 때 이미 92건에 포함), **A094–A096만 2026-10-20**. Snippets도 같은 방법으로 N001–N020은 10-05~10-13, **N021–N032는 10-19** → 10-14 기록 "20 snippets"와 정확히 맞는다. Shots는 영상 업로드일과 게시 순서가 어긋나서(예: S2140은 10-08 업로드, S2136은 10-20) 날짜로 못 가른다. sitemap 상세 경로 수 차이(2,124 − 2,094 = 30)와 첫 화면 목록(S2109–S2140)으로 **S2110–S2140(번호 31개, 결번 없음) ≈ 30건**을 신규로 본다. 10-14 집계 방식(목록 페이지 포함 여부)을 확인할 수 없어 경계는 ±1–5로 둔다(추정).
- **신규 App Sites 3건은 모두 Apple 마케팅 스크롤 페이지**(HomeView ×2, Safari)라 모바일 에이전트 앱과의 관련성은 낮다. 이번 조사의 실질적인 신규 소재는 **Snippets 12건**(확인 버튼·삭제 확인·드롭다운 모핑·숫자 입력·그래프 스크럽 등, 스프링 값 포함)과 **Shots ≈30건**(카드→시트 모핑, 계정 생성 완료, 카운터, 확인 시트 등)이다.

### 1-2. 방법

1. **목록**: `robots.txt` 확인(일반 UA 허용, 학습용 크롤러만 차단 — 이번 조사는 학습 아님) → `sitemap.xml`(3,188 경로)로 섹션별 전수 → `/`, `/appsites`, `/motion`, `/snippets` SSR HTML로 번호·제목 대조.
2. **상세**: 단일 연결, 요청 간 1.2초 이상 간격(실효 0.3–0.6 req/s)으로 상세 HTML만 받음(gzip). 추출: 번호, 제목, 긴 설명, 카테고리, 태그, `VideoObject`(제목·영상 URL·업로드일), Snippets는 Requires/Built with/Inspired by + 무료 공개 코드 구간의 스프링·지속시간 리터럴.
3. **타이밍 추정(영상)**: 상세의 메인 영상(gumlet `main.mp4`, 대부분 60fps H.264, 일부 15/25fps) 49개를 받아 96px 폭 회색조로 줄인 뒤 **프레임 간 변화 화소 수**로 "움직임 버스트" 길이를 셌다(조사용 임시 스크립트, 저장소에는 넣지 않음. 원자료는 부록 F의 버스트 파일). 손가락 이동·스크롤·키보드가 섞인 **상한 추정치**다. **보정**: 코드 값을 아는 N012(spring .36/.92, t99 = 311ms)의 영상이 280–360ms로 나와서 "버스트 ≈ t99(1% 안착) ± 1프레임"으로 읽는다.
4. **실측**: (a) 오늘 60fps.design 자체 성능 — Playwright + 시스템 Chrome, 390×844 DPR3, 무스로틀, CDP 전송량·요청 수, PerformanceObserver FCP/LCP/CLS/long task, `<video>` preload 상태. (b) Snippets 코드의 스프링 파라미터(작성자가 실제 앱을 보고 맞춘 값; 일부는 주석에 "observed … about 0.22 seconds"처럼 관찰값을 적어 둠). (c) 1차 조사(10-05)의 60fps 런타임 토큰 관측값(hover 200ms 등)은 그대로 인용.
5. **우리 쪽**: `docs/design/MOTION-SPEC.md` 전문, REA 보고서와 실제 피클 앱 스크린샷 5장(`runtime-01~05`), 현재 빌드 QA 캡처(`docs/qa/v2-*`, `v3-midswitch`, `v4-*`), `apps/mobile/src`의 파일 구성(`motion/springs.ts`, `ui/TabBar.tsx` 등)을 확인했다. 코드는 읽기만 했다.
6. **ID 표기**: `A###` App Sites, `M###` Motion(1차 조사 번호와 동일), `S####` Shots(60fps 번호), `N###` Snippets(60fps 번호, Shots와 겹치지 않게 N). 링크는 §2 표와 부록.

### 1-3. 볼 수 없었던 것(정직하게)

- **Shots 필터 페이지**(`/shots/filter/*`, Liquid Glass·AI·Chat·Voice 포함)는 앞 몇 개만 보이고 나머지는 "Unlock with PRO" 게이트. 게이트 뒤 목록은 쓰지 않았고, 공개 sitemap 슬러그를 키워드로 골라 **무료 상세 페이지**를 열었다. 그래서 키워드에 안 걸린 관련 샷이 남아 있을 수 있다(예: 제목에 "chat"이 없는 채팅 UI).
- **Snippets 코드**는 무료 구간만 보인다("N more lines in the full snippet, with PRO"). 스프링 값은 무료 구간에 나온 것만 적었다.
- **Storyboards** 62건, 필터별 정렬, MCP 서버 결과물은 PRO라 열람하지 않았다.
- 상세 열람 672건 외의 Shots(≈1,450건)는 **슬러그만** 확인했다(부록 F의 전 경로 파일). 제목·설명을 지어내지 않았다.
- 영상 타이밍은 전부 **추정**이다. 화면 녹화라 터치 시작 시점을 정확히 알 수 없고, 15/25fps 영상은 ±67/40ms 오차가 있다.

### 1-4. 60fps.design 자체 실측(오늘, 참고)

| 페이지 | 전송량 / 요청 | JS | FCP | LCP(요소) | CLS | long task | 영상 |
|---|---|---|---|---|---|---|---|
| `/` | 2,297KB / 94 | 806KB | 644ms(콜드) | 1,160ms(video poster) | 0.0004 | 179·228·50ms | 18개 중 17개 `preload=none`, 일시정지 |
| `/appsites` | 2,435KB / 58 | 778KB | 112ms | 224ms(poster) | 0 | 85ms | 10개 전부 `preload=none` |
| Shot 상세(S2043) | 2,962KB / 72 | 803KB | 388ms | — | 0 | 95·94ms | 메인 1개만 재생(935KB), 관련 9개 정지 |
| Snippet 상세(N012) | 2,314KB / 69 | **1,048KB** | 964ms | 1,316ms | 0.0004 | — | 메인 1개 재생 |

- 10-05 측정과 거의 같다(Framer 런타임 JS ≈0.8–1.0MB, poster-first, 목록 영상은 hover해도 재생 안 함). 배울 점은 그대로 **"목록은 정지 포스터, 상세에서 하나만 재생"**, 피할 점은 **런타임 1MB와 콜드 FCP 644ms·long task 228ms**다. 우리 PWA는 첫 화면 JS를 이 1/5 이하로 잡는다(§5).

## 2. 신규·관련 사례 표

> 타이밍 표기: **코드** = Snippets의 SwiftUI 리터럴(작성자가 원본 앱을 보고 맞춘 값, 무료 공개 구간), **실측** = 오늘 라이브 페이지에서 잰 값, **추정** = 60fps 영상 프레임 차분(버스트 ≈ t99, 손가락·키보드 포함 상한). t90/t99/오버슈트는 코드의 `spring(response, dampingFraction)`를 우리 `springs.ts`와 같은 식(stiffness = (2π/response)², damping = 2ζ·2π/response)으로 계산한 값.

### 2-1. 10-14 이후 신규 — App Sites 3건

| ID | 이름 | 분류 | 메커니즘 | 타이밍 | 왜 통하나 | 우리 앱 매핑 |
|---|---|---|---|---|---|---|
| [A094](https://60fps.design/appsites/apple-homeview-scroll-interaction) | Apple HomeView Scroll Interaction | 마케팅·스크롤 3D | 스크롤 진행도에 제품 3D 카메라를 묶어 기능 하이라이트 사이를 이동 | 스크롤 연동(시간 없음) | 스크롤 = 타임라인이라 사용자가 속도를 쥔다 | **매핑 없음**(앱 화면에 스크롤 연출 금지, §6-15) |
| [A095](https://60fps.design/appsites/apple-safari-3d-perspective-logo-animation) | Apple Safari 3D Perspective Logo Animation | Hero·텍스트 순환 | 헤드라인이 세로 크로스페이드로 순환 + WebGL 나침반 로고 기울기 | 417–1,117ms/전환(추정) | 브랜드 로고에 깊이 | **반면교사**: 정보 없는 문구 순환·크로스페이드(§6-2, §6-6) |
| [A096](https://60fps.design/appsites/apple-homeview-zoom-scroll-interaction) | Apple HomeView Zoom Scroll Interaction | 스크롤·줌아웃 | 전체 화면 시계 화면이 스크롤에 따라 축소되며 다열 그리드로 | 한 구간 ≈700ms 분량(추정) | "하나 → 여럿"을 공간으로 설명 | 보관함 "아티팩트 하나 → 목록" 복귀 시 **카드가 제자리로 줄어드는 공유 요소**(스크롤 연동이 아니라 탭 연동으로) |

> 10-08 업로드분 A089–A093(10-14 조사 시점에 이미 92건에 포함)도 오늘 상세를 열었다. 관련 있는 것: [A093](https://60fps.design/appsites/graphical-header-pill-tap-interaction) Graphical 문장 속 pill 탭(pill이 커지며 문장이 다시 흐름, 버스트 중앙값 183ms·100–200ms, 추정) → **채팅 본문 속 엔티티 칩**(일정·장소·사람)을 눌렀을 때 칩만 커지고 문단은 레이아웃 애니메이션으로 밀려나는 패턴. [A091](https://60fps.design/appsites/mike-barton-swipe-boarding-pass-to-enter-interaction) Mike Barton 탑승권을 슬롯에 끌어 넣기(드래그 767ms, 삽입 483ms, LED 성공 117ms, 추정) → 승인 카드의 "끌어서 승인" 대안으로는 **채택하지 않음**(정확한 드래그를 요구, 접근성 불리). [A092](https://60fps.design/appsites/openai-dots-intro-mascot-animation) OpenAI 점 마스코트 모핑(1.35–1.5s/모핑, 추정) → 온보딩 캐릭터의 **상태 전환**(듣기↔생각) 참고, 루프로는 쓰지 않음.

### 2-2. 10-14 이후 신규 — Snippets 12건(N021–N032, 2026-10-19)

| ID | 이름(원본 앱) | 메커니즘 | 타이밍(코드) | 계산 t90 / t99 / 오버슈트 | 왜 통하나 | 우리 앱 매핑 |
|---|---|---|---|---|---|---|
| [N022](https://60fps.design/snippets/delete-to-confirm-button-interaction) | Delete to Confirm Button (Five Cents) | "삭제" 버튼이 같은 자리에서 "확인" 버튼으로 늘어나며 문구 교체 | spring(.32,.92); 나감 easeIn .08/.20, 들어옴 easeOut .10/.12; **reduceMotion 분기 있음** | 179 / 278ms / 0.05% | 위험 행동에 두 번째 탭을 요구하되 **화면 이동 없이** 같은 자리에서 | 볼트 "삭제", 일정 "삭제", 대화 "나가기", 친구 "차단"의 2단계 확인 — **승인 카드의 접근성 대안**(§3-4) |
| [N029](https://60fps.design/snippets/cancel-button-expand-to-confirm-interaction) | Cancel Button Expand to Confirm | "취소"가 확장되어 "정말 취소" 확인으로 | spring(.35,.88); easeOut .10/.12 | 185 / 271ms / 0.27% | N022와 같음, 취소 쪽 | 진행 중인 에이전트 작업 "멈추기" → "작업 멈추기 · 지금까지 결과 보관" 확인 |
| [N030](https://60fps.design/snippets/dropdown-menu-expand-morph-interaction) | Dropdown Menu Expand Morph (Circle) | 작은 버튼이 메뉴 패널로 모핑, 항목이 짧은 지연 뒤 들어옴 | spring(.25,.83)·(.27,.94)·(.34,.88); 항목 easeOut .06–.18; **reduceMotion이면 .12** | 124–180 / 169–264ms / ≤0.86% | 출처(버튼)에서 자라나 공간 관계가 끊기지 않음 | 상단바 아바타 캡슐 → 에이전트 메뉴, 메시지 길게 누르기 메뉴, 모델·모드 선택 |
| [N028](https://60fps.design/snippets/comma-jump-number-input-interaction) | Comma Jump Number Input (Family) | 숫자 입력 중 천 단위 쉼표가 자리를 옮기며 숫자들이 밀림 | spring(.22,.88); easeIn .08 / easeOut .14 | 116 / 171ms / 0.25% | 입력 반응이 손가락보다 빠름, 숫자 정렬 유지 | 결제 한도·금액 입력(볼트 결제 수단, 승인 금액 편집) |
| [N031](https://60fps.design/snippets/graph-scrub-highlight-glow-interaction) | Graph Scrub Highlight Glow (Revolut) | 그래프를 손가락으로 훑으면 해당 지점 강조 | easeOut .12/.16/.20 | — | 직접 조작, 지연 없음 | 프로필 7일 사용량 차트 스크럽(**글로우는 빼고** 툴팁만) |
| [N024](https://60fps.design/snippets/tap-to-hold-button-pulse-morph-interaction) | Tap to Hold Button Pulse Morph (Monogram) | 마이크 pill: 탭 = 토글, 길게 = 누르는 동안 녹음, 손 떼면 처리 pill로 모핑 | easeInOut .15/.20/.27, 16ms 틱 | — | 하나의 컨트롤로 두 가지 의도를 구분 | 컴포저 마이크(탭 = 받아쓰기 시작/정지, 길게 = 누르는 동안 말하기) |
| [N023](https://60fps.design/snippets/free-trial-switch-amount-change-interaction) | Free Trial Switch Amount Change (Exoplan) | 토글을 켜면 금액이 바뀌며 KeyframeAnimator 강조 | spring(.27,.72); easeOut .16 | 116 / 282ms / **3.7%** | 가격 변화를 즉시 보여 줌 | 스위치 → 금액 연동은 참고, **오버슈트 3.7%는 상한 초과**(§6-5) |
| [N032](https://60fps.design/snippets/subscribe-button-change-interaction) | Subscribe Button Change (Queue) | 구독 버튼 → 구독 중 상태로 모양·문구 변경 | easeInOut .30 | — | 상태 변화를 버튼 자체로 | 둘러보기 "부탁하기" → "맡김" 상태(서버 확인 뒤) |
| [N025](https://60fps.design/snippets/plus-to-tick-button-animation) | Plus to Tick Button (Apple TV) | + 획이 회전하며 체크로 다시 그려짐 | **linear .65(저장)/.60(해제)**, 경로 구간 분할 | — | 아이콘이 상태를 말함 | 일정 추가, 친구 추가, "보관함에 저장" — 저장은 **서버 확인 뒤** 체크 |
| [N027](https://60fps.design/snippets/tactile-button-interaction) | Tactile Button (Duolingo) | 버튼 면과 라벨이 4pt 함께 내려감, **스케일·스프링 없음**(주석: "no scale, spring, or timed release") | 즉시(누르는 동안 유지) | — | 가장 싼 피드백이 가장 빠름 | 불투명 버튼 press의 근거(우리 규칙은 "never shrink" → 아래로 2px + 6% 어둡게) |
| [N026](https://60fps.design/snippets/button-border-stroke-pulse-animation) | Button Border Stroke Pulse (Revolut) | 버튼 테두리에 빛 스트로크가 돈다 | TimelineView 루프 | — | 시선을 끈다 | **금지**(글로우 루프, §6-1) |
| [N021](https://60fps.design/snippets/card-fire-burn-particle-effect-interaction) | Card Fire Burn Particle (How We Feel) | 카드를 태우는 입자 효과 | TimelineView + Canvas | — | 감정적 연출 | **금지**(파티클, §6-4) |

### 2-3. Snippets 1–20 중 우리 앱과 직결되는 것(10-14 조사 이후 코드 재확인)

| ID | 이름(원본 앱) | 핵심 값(코드) | 계산 t90 / t99 | 우리 앱 매핑 |
|---|---|---|---|---|
| [N012](https://60fps.design/snippets/keyboard-to-input-morph-interaction) | Keyboard to Input Morph (Monogram) | spring(.36,.92), 옆 버튼 easeOut .12 | 201 / 312ms | **컴포저 키보드 ↔ 입력창 모핑**. 영상 버스트 280–360ms(추정)로 t99와 일치 → 버스트 보정 기준 |
| [N017](https://60fps.design/snippets/bottom-sheet-detail-expansion-interaction) | Bottom Sheet Detail Expansion (Family) | spring(.36,.94) | 206 / 330ms | 시트 내부 "자세히" 확장(승인 카드 → 보낼 내용 전문) |
| [N014](https://60fps.design/snippets/see-all-menu-expand-interaction) | See all Menu Expand (Captions) | spring(.36,.90), contentTransition | 196 / 295ms | 도구 단계 요약 pill → 전체 단계 펼치기 |
| [N004](https://60fps.design/snippets/plan-switch-card-expand-interaction) | Plan Switch Card Expand (AllTrails) | spring(.42,.94), easeInOut .12 | 241 / 385ms | 요금·티켓 선택 카드 |
| [N008](https://60fps.design/snippets/line-graph-morph-interaction) | Line Graph Morph (Family) | spring(.32,.82) | 156 / 298ms / 1.05% | 사용량 차트 기간 전환(7일 ↔ 30일) — 막대 높이 모핑 |
| [N011](https://60fps.design/snippets/hide-sensitive-number-interaction) | Hide Sensitive Number (Family) | easeInOut .15, linear .10 | — | 볼트 비밀번호·카드번호 가리기/보기 |
| [N010](https://60fps.design/snippets/otp-input-pulse-fill-success-interaction) | OTP Input Pulse Fill Success (Toss) | 자동 입력 6.0s(데모), 틱 16ms(감소 모드 250ms) | — | 카카오 연결 인증번호, 기기 인증 |
| [N007](https://60fps.design/snippets/hold-to-commit-button-interaction) | Hold to Commit (Opal) | **linear 2.0s** 채움, easeOut .18, reduceMotion이면 0 | — | 고위험 승인의 길게 누르기(우리는 1.2s, §3-4) |
| [N009](https://60fps.design/snippets/continue-button-to-tick-animation) | Continue Button to Tick (CRED) | 1.617s 시퀀스, 60fps TimelineView, scenePhase 비활성 시 정지 | — | 로더→체크(우리 §3 "Loader → check")의 전체 길이 참고 — 우리는 서버 응답에 맞춰 가변 |
| [N018](https://60fps.design/snippets/bottom-tabs-active-tab-expansion-interaction) | Bottom Tabs Active Tab Expansion (Neuecast) | easeOut .22(주석 "observed … about 0.22 seconds"), matchedGeometryEffect | 220ms | 탭 바 활성 탭 확장 — 우리 two-edge 드롭렛과 같은 길이대 |
| [N005](https://60fps.design/snippets/forward-toast-icon-animation) | Forward Toast Icon (Telegram) | easeOut .15/.20 | — | "보냈어요" 토스트 아이콘(서버 확인 뒤) |
| [N013](https://60fps.design/snippets/mini-player-play-and-scrub-interaction) | Mini Player Play and Scrub | easeOut .18 | — | 통화 중 미니 컨트롤(Island 확장) |
| [N006](https://60fps.design/snippets/number-flip-with-reflection-interaction) | Number Flip with Reflection (Push) | smooth(.30), contentTransition | — | 할당량 % 오도미터 |
| [N002](https://60fps.design/snippets/circle-progress-fill-interaction) | Circle Progress Fill (GrowPal) | 1.6s 채움, reduceMotion이면 즉시 최종값 | — | 연결 대기 카운트다운 링 |
| [N019](https://60fps.design/snippets/spin-to-circle-animation) | Spin to Circle (ChatGPT) | 링이 2.6s 동안 40→320pt로 커지며 회전, 3.2s에 채움 | — | 음성 모드 진입 — **회전 그라디언트는 빼고** 크기 변화만 |
| [N015](https://60fps.design/snippets/list-fade-up-from-down-interaction) | List Fade Up from Down (Vakitler) | TimelineView | — | 첫 방문 목록 등장(editorial, 30ms×4 상한) |

> **결론(스프링 표)**: 60fps 스니펫 작성자들이 원본 앱에서 맞춘 컴포넌트 내부 스프링은 **t90 116–241ms, ζ .82–.94**에 몰려 있다. 우리 `springs.ts`의 `snap`(163ms)·`lead`(144)·`trail`(216)·`morph`(232)가 정확히 이 범위에 들어간다. **새 역할은 필요 없다.** 단, 확인 버튼류(N022/N029)는 우리 `snap`보다 살짝 느린 t90 ≈180ms라 "확인 확장"은 `snap` 그대로 써도 체감 차이가 없다.

### 2-4. 10-14 이후 신규 — Shots(S2110–S2140, 약 30건) 중 관련 있는 것

| ID | 이름 | 분류 | 메커니즘 | 타이밍(추정) | 왜 통하나 | 우리 앱 매핑 |
|---|---|---|---|---|---|---|
| [S2126](https://60fps.design/shots/plasma-duo-style-bottom-sheet-open-interaction) | Plasma Duo Style Bottom Sheet Open | 카드→시트 | 대시보드 제안 카드가 커지며 상세 시트로 모핑, 배경 dim+blur, 스프링 안착 | 567 / 717 / 933 / 1,483ms | 출처가 끊기지 않아 "어디서 왔는지" 안다 | **둘러보기 일 카드 → "맡기기 전 확인" 시트**(§4-4). 배경은 dim만(blur 없음) |
| [S2137](https://60fps.design/shots/plasma-card-setup-animation) | Plasma Card Setup | 서버 완료 → 화면 전환 | 계정 생성 중 카드에 로딩 표시, **시스템 이벤트로 완료되면** 헤더가 사라지고 카드가 위로 이동·축소 | 533ms | 완료를 서버 이벤트에 묶음 | 가입 시트: 서버 확인 → 시트가 상단바 아바타로 수축(MOTION-SPEC §6-1과 같은 방향) |
| [S2123](https://60fps.design/shots/circle-new-wallet-claim-balance-interaction) | Circle New Wallet Claim Balance | 버튼 로딩 + 숫자 티커 | 버튼이 "loading wallet…"로, 카드 숫자가 세로 모션블러 티커로 올라감, 캡션이 뒤에 등장 | 650 / 1,450ms | 금액이 "생겨나는" 순간을 보여 줌 | 티켓 사용 후 할당량 막대 회복(오도미터, **모션블러 없이**) |
| [S2135](https://60fps.design/shots/runmo-days-counter-interaction) | Runmo Days Counter | 스테퍼 + 카운터 | ± 버튼으로 숫자가 세로 티커, 요일 pill 동시 토글 | 283ms(중앙값) | 숫자와 근거(요일)가 함께 움직임 | 예약된 일 "반복 요일" 편집 |
| [S2120](https://60fps.design/shots/revolut-create-close-pocket-interaction) [S2116](https://60fps.design/shots/revolut-create-delete-pocket-interaction) | Revolut Create / Close Pocket | 생성·삭제 확인 시트 | 생성 후 scale+fade로 새 화면, "닫기"는 확인 시트 → (S2116) 입자 분해 | 333ms(중앙값), 최대 883ms | 확인 시트는 좋고 분해 효과는 과함 | 확인 시트는 채택(친구 차단·볼트 삭제), **분해 효과는 금지** |
| [S2119](https://60fps.design/shots/revolut-select-plan-tab-scroll-interaction) | Revolut Select Plan Tab Scroll | 상단 탭 + 페이징 | 탭/스와이프로 요금제 전환, 가격·기능 crossfade, 배경 그라디언트 변색 | 533ms(중앙값) | 스와이프와 탭 둘 다 됨 | 탭+스와이프 동기화는 채택, crossfade·전체 변색은 금지 |
| [S2117](https://60fps.design/shots/revolut-feature-buttons-coachmark-border-pulse-interaction) [S2118](https://60fps.design/shots/revolut-revpoints-feature-coachmark-border-pulse-interaction) | Revolut Coachmark Border Pulse | 코치마크 투어 | 스크림 + 버튼 테두리 맥동 + 헤드라인 순차 교체 | 283ms | — | **금지**(§6-12) |
| [S2121](https://60fps.design/shots/cred-printing-tickets-shuffle-interaction) | CRED Printing Tickets Shuffle | 구매 완료 | 버튼 "인쇄 중" → 확인, 티켓 카드가 위로 올라와 가로 갤러리로 정렬 | — | 구매 결과물이 눈앞에 | 티켓 사용 완료 후 남은 티켓 수 표시(카드 연출은 과함) |
| [S2112](https://60fps.design/shots/run-receipt-signature-interaction) | Run Receipt Signature | 서명 입력 | 서명 시트에서 그리고 확인 → 시트가 내려가며 서명이 영수증에 렌더 | — | 결과가 원래 문맥에 들어감 | 승인 결과(서명된 영수증)가 대화 스레드 카드에 들어가는 방식 |
| [S2102](https://60fps.design/shots/district-weekend-pick-card-scroll-snap-selection-interaction) | District Weekend Pick Card Scroll Snap | 스크롤 스냅 리스트 | 가운데 항목만 펼쳐지고 나머지는 높이·투명도 보간 | — | 하나에 집중 | **채택하지 않음**(목록 탐색을 느리게 함) |
| [S2097](https://60fps.design/shots/revolut-number-of-transactions-interaction) | Revolut Number of Transactions | 숫자 세그먼트 | 1–5 세그먼트 pill이 늘어나며 이동(설명 "bouncy"), 미리보기 레이아웃 갱신 | — | 늘어나는 pill = two-edge | two-edge는 이미 우리 규칙, 바운스는 금지 |
| [S2099](https://60fps.design/shots/netflix-poster-reflection-on-bottom-tabs-interaction) | Netflix Poster Reflection on Bottom Tabs | Liquid Glass 탭 바 | 가로 포스터 스크롤 위에 떠 있는 pill 탭 바, 아래 콘텐츠가 비침 | — | 실제 iOS 26 탭 바의 기준 장면 | 우리 탭 바: 콘텐츠가 탭 바 아래로 지나가야 글래스가 의미 있음(현재 빌드는 뒤가 거의 비어 있음) |
| [S2138](https://60fps.design/shots/revolut-card-ready-animation) | Revolut Card Ready | 완료 화면 | 그라디언트 면이 3D 카드로 응축, 회전 안착 | — | 결과물 공개 | 3D 연출은 과함. 참고만 |
| [S2133](https://60fps.design/shots/runmo-fresh-start-loader-interaction) | Runmo Fresh Start Loader | 가져오기 진행 | "Importing your runs" + 채워지는 진행 pill → 완료 문구 교체 | — | 진행이 실제 단계 | 연결 직후 "카카오톡 대화 불러오는 중" 진행(확정 진행이면 막대, 아니면 단계 이름) |
| [S2110](https://60fps.design/shots/x-campaign-hashtag-based-grok-bot-like-button-interaction) [S2113](https://60fps.design/shots/threads-splash-logo-animation) [S2124](https://60fps.design/shots/duolingo-sparkle-sculpt-pop-interaction) [S2127](https://60fps.design/shots/runmo-splash-animation) [S2131](https://60fps.design/shots/circle-splash-bubbles-pop-interaction) [S2132](https://60fps.design/shots/whatnot-splash-animation) [S2136](https://60fps.design/shots/dood-splash-animation) [S2111](https://60fps.design/shots/revolut-splash-intro-video-sequence) [S2114](https://60fps.design/shots/duolingo-battery-fill-up-interaction) [S2115](https://60fps.design/shots/revolut-single-use-pulse-card-sweep-morph-animation) [S2108](https://60fps.design/shots/uber-search-border-highlight-animation) [S2103](https://60fps.design/shots/uber-loading-animation) | 스플래시·파티클·글로우·로고 루프 | — | — | — | — | 전부 **반면교사**(§6) |
| [S2128](https://60fps.design/shots/runmo-drag-to-adjust-distance-wheel-interaction) [S2134](https://60fps.design/shots/runmo-distance-wheel-fill-interaction) [S2139](https://60fps.design/shots/runmo-lab-pulse-heart-ecg-interaction) [S2140](https://60fps.design/shots/apple-health-longevity-intro-animation) [S2129](https://60fps.design/shots/runmo-intro-value-prop-carousel-interaction) [S2130](https://60fps.design/shots/brick-intro-value-prop-text-flip-interaction) [S2122](https://60fps.design/shots/cred-ticket-pop-on-slider-interaction) [S2125](https://60fps.design/shots/apple-app-store-app-page-header-asset-animation) [S2109](https://60fps.design/shots/platen-typewriter-intro-how-to-interaction) [S2107](https://60fps.design/shots/cred-autopay-bills-stack-animation) [S2106](https://60fps.design/shots/aave-intro-value-prop-3d-clock-animation) [S2105](https://60fps.design/shots/aave-intro-value-prop-3d-lock-animation) [S2104](https://60fps.design/shots/aave-intro-value-prop-3d-coin-spin-animation) [S2101](https://60fps.design/shots/apple-customize-control-center-how-to-animation) [S2100](https://60fps.design/shots/x-nfl-games-tab-switch-interaction) [S2098](https://60fps.design/shots/cred-swipe-to-pay-interaction) [S2096](https://60fps.design/shots/monologue-intro-animation) [S2095](https://60fps.design/shots/zomato-no-internet-offline-game-interaction) | 피트니스 다이얼·3D 가치 제안·오프라인 게임 등 | — | — | — | — | 관련 낮음(부록 목록) |

### 2-5. 에이전트·AI 앱 관련 기존 사례(10-14 이전 게시, 이번에 상세·영상 확인)

| ID | 이름 | 분류 | 메커니즘 | 타이밍(추정) | 왜 통하나 | 우리 앱 매핑 |
|---|---|---|---|---|---|---|
| [S2043](https://60fps.design/shots/monogram-pulse-sweep-chat-response-reveal-interaction) | Monogram Pulse Sweep Chat Response Reveal | 생성 중 → 응답 | 제안 카드 선택 → 하단 pill이 듣기/생각 상태로, 제안 카드는 미끄러져 사라지고 구조화된 응답·아이콘 목록이 들어옴 | 700(pill→생각), 317, 1,150(응답 공개) | 입력 수단 자체가 상태 표시가 됨 | **컴포저가 생성 중 상태로 모핑**(전송 → 멈추기), 제안 칩은 같은 자리에서 사라짐 |
| [S2047](https://60fps.design/shots/monogram-pulse-calendar-connect-reveal-interaction) | Monogram Pulse Calendar Connect Reveal | 도구 사용 표시 | 하단 상태 pill "Searching your Calendar" → 검색이 끝나면 pill이 바뀌고 권한 카드 공개 | 417 / 183–200 / 783(권한 카드) | 도구 이름이 그대로 상태 문구 | Island "캘린더 확인하는 중" → 권한 필요하면 **스레드 안 권한 카드** |
| [S2050](https://60fps.design/shots/monogram-tap-and-hold-mic-liquid-blur-pulse-interaction) | Monogram Tap and Hold Mic Liquid Blur | 길게 눌러 말하기 | pill → 원형 마이크 모핑, 배경 점진 블러, 실시간 받아쓰기, 손 떼면 "Searching the internet…" 로딩 pill | 417–450(누름 모핑), 1,100(블러), 700(답 공개) | 하나의 버튼에 말하기·처리 상태 | 컴포저 마이크 길게 누르기(**블러 대신 dim**) |
| [S2041](https://60fps.design/shots/monogram-keyboard-icon-morph-to-chat-input-interaction) | Monogram Keyboard Icon Morph to Chat Input | 입력 모드 전환 | 키보드 내려가면 입력창이 아래 pill 바(+ · 마이크 · 키보드 아이콘)로 모핑, 반대도 | 383(중앙값, 350–467, 키보드 포함) | 화면 하단 크롬을 줄임 | **컴포저 휴식 상태 = 작은 pill**(§4-2), N012 값 사용 |
| [S2042](https://60fps.design/shots/monogram-rich-chat-response-card-swipe-interaction) | Monogram Rich Chat Response Card Swipe | 리치 응답 카드 | 응답 안 카드 묶음을 가로로 넘김 | 217(중앙값) | 긴 목록을 접음 | 브리핑 카드의 항목들(가로 넘김 대신 접힌 목록 + "더 보기") |
| [S1848](https://60fps.design/shots/eimi-generating-card-preview-morph-pop-scale-in-sheet-animation) | Eimi Generating Card Preview Morph Pop | 생성 중 → 완료 | 점선 카드 자리표시 → 완성 카드가 커지며 등장, 버튼 **Stop → Done** 교체 | 717–800 | 생성 중에도 멈출 수 있고, 끝나면 같은 버튼이 완료로 | 아티팩트 생성 카드: **멈추기 → 열기**(같은 버튼 모핑), 팝 바운스는 빼기 |
| [S1861](https://60fps.design/shots/district-ask-ai-intro-sheet-animation) | District Ask AI Intro Sheet | AI 검색 시트 | 시트 안 입력 → 제출하면 입력창이 맥동하는 별로 모핑 → 결과 카드 | 시트 417, 모핑 550–650 | 입력이 곧 진행 표시 | 둘러보기 검색에 자연어 질문 → 결과 카드(별 맥동은 빼고 Island 사용) |
| [S1922](https://60fps.design/shots/swiggy-chat-response-loading-animation) | Swiggy Chat Response Loading | 대기 문구 | 메시지 전송 → 말풍선, 그 아래 요리 문구가 순환 | 문구당 ≈117 | 대기를 덜 지루하게 | **반면교사**(실제 단계 아닌 문구) |
| [S1945](https://60fps.design/shots/avec-hold-and-speak-interaction) | Avec Hold and Speak | 길게 눌러 말하기 | 파란 "Hold & speak" → 누르면 빨강(녹음), 떼면 파랑 + 문구 갱신 | 색 변화 100–150 | 녹음 중이 확실함 | 녹음 중 = 아이콘 + "듣는 중" 문구 + 레벨 막대(색만으로 표시 금지) |
| [S2039](https://60fps.design/shots/chatgpt-voice-blob-gradient-interaction) | ChatGPT Voice Blob Gradient | 음성 모드 종료 | 가운데 구가 빠르게 줄며 사라지고 채팅 화면 요소가 제자리로 | 300 | 닫힘이 빠름 | 통화 종료: 카드 → Island로 300ms 안에 수축 |
| [S2053](https://60fps.design/shots/chatgpt-model-intensity-slider-interaction) | ChatGPT Model Intensity Slider | 단계 슬라이더 | 키보드 위로 슬라이더가 펼쳐지고 단계마다 스냅, 라벨 교체 | 단계 300, 펼침 367 / 617 | 모델 선택을 입력 맥락에서 | 컴포저 "+" 메뉴 안 "답변 길이/속도" 같은 단계 선택(라벨은 콘텐츠 스왑) |
| [S1977](https://60fps.design/shots/chatgpt-intelligence-picker-long-press-slider-interaction) | ChatGPT intelligence picker | 길게 눌러 단계 선택 | 길게 눌러 슬라이더로 단계 선택 | 단계 133(중앙값) | 빠른 단계 피드백 | 위와 같음 |
| [S2055](https://60fps.design/shots/claude-voice-selection-border-pulse-interaction) | Claude Voice Selection Border Pulse | 음성 선택 | 캐러셀 카드 중앙 스냅, 미리듣기 중 테두리가 말소리에 맞춰 맥동 | — | 소리와 화면 동기 | 모시 목소리 선택: **레벨 막대**로 동기(테두리 글로우 대신) |
| [S2017](https://60fps.design/shots/grok-app-connected-pulse-animation) [S1991](https://60fps.design/shots/grok-tool-connected-pulse-animation) | Grok App/Tool Connected Pulse | 연결 완료 | 시트에서 앱 로고 뒤 맥동 후 "Gmail is connected" + "Chat with Grok" 순차 등장 | 400 / 1,200(15fps) | 다음 행동을 바로 제시 | 연결 완료 시트: 체크가 그려진 뒤 **"이제 이렇게 부탁해 보세요" 예시 칩**(맥동 글로우 대신) |
| [S1990](https://60fps.design/shots/grok-connect-tools-logo-carousel-spin-animation) [S1952](https://60fps.design/shots/grok-app-icons-in-sheet-arc-animation) | Grok Connect Tools Logo Carousel / Arc | 연결 소개 | 시트 상단 앱 로고들이 궤도로 계속 회전 | 루프 | — | **반면교사**(상시 루프) |
| [S2079](https://60fps.design/shots/wabi-soothing-loading-fade-reveal-animation) | Wabi Soothing Loading Fade Reveal | 개인화 준비 | 원형 파문 → 전체 화면 앰비언트 로딩, 상태 문구가 **제자리에서** 교체("Learning about you…") | — | 문구가 실제 단계에 대응 | 첫 실행 개인화(연결한 앱 읽는 중) — 문구 교체만 채택, 전체 화면 그라디언트는 빼기 |
| [S1710](https://60fps.design/shots/wabi-chat-suggestion-swipe-cards-carousel-interaction) | Wabi Chat Suggestion Swipe Cards | 제안 카드 → 입력 | 제안 카드의 "Try it"을 누르면 카드 문구가 입력창으로 날아감 | 417(중앙값), 최대 1,650(스와이프 포함) | 제안이 내 입력이 되는 과정이 보임 | **"깽이의 제안"/빈 채팅 제안 칩 → 컴포저로 문구 이동**(공유 요소) |
| [S1567](https://60fps.design/shots/queue-ask-ai-chat-random-prompt-interaction) | Queue Ask AI Chat Random Prompt | 제안 → 전송 | 제안 문구가 보낸 메시지로 스레드에 들어가고 크레딧 카운터 감소 | — | 비용이 보임 | 무료 한도 사용량을 전송 시점에 Island/프로필에 반영 |
| [S1564](https://60fps.design/shots/perplexity-model-selection-sheet-morph-interaction) | Perplexity Model Selection Sheet Morph | 시트 안 모핑 | 모드 시트 → 드롭다운이 시트 높이를 키우며 펼쳐지고 항목 스태거 | 367(중앙값, 333–417) | 시트 안에서 깊이가 생김 | 시트 내부 확장 규칙(N017 값). 배경 blur는 빼기 |
| [S1476](https://60fps.design/shots/google-ai-mode-search-morph-interaction) | Google AI Mode Search Morph | 검색바 → AI 모드 | 검색바가 전체 화면 AI 모드로 커지고 되돌아감 | 433(중앙값, 317–450) | 되돌릴 수 있는 확장 | Spotlight 검색에서 "모시에게 물어보기"로 전환(검색바가 컴포저로 모핑) |
| [S1541](https://60fps.design/shots/grok-pull-down-to-go-back-interaction) | Grok Pull Down to Go Back | 상세 → 그리드 | 아래로 끌면 카드가 그리드 자리로 돌아감(공유 요소) | 500 / 1,133–1,650(드래그 포함) | 손으로 닫는 상세 | 아티팩트 뷰어: 아래로 끌어 닫으면 보관함 카드 자리로 |
| [S1015](https://60fps.design/shots/grok-chat-menu-interaction) | Grok Chat Menu | + 메뉴 | + 탭 → 키보드 내려가고 채팅이 뒤로 흐려지며 빠른 동작 목록 | 433 | 첨부 메뉴가 입력 맥락에 붙음 | 컴포저 + 메뉴(카메라·사진·파일·연결 앱) — 배경은 dim만 |
| [S1484](https://60fps.design/shots/cobot-toast-expand-shrink-interaction) | Cobot Toast Expand Shrink | 오류 토스트 | "Authentication failed" pill이 가로로 줄어 빨간 점이 되었다가 사라짐 | 1,200(전체 시퀀스) | 오류가 사라지는 방향이 보임 | **오류 배너가 Island로 돌아가며 점 → 사라짐**(MOTION-SPEC §3 Banner와 같은 방향) |
| [S1220](https://60fps.design/shots/toss-otp-successful-animation) | Toss OTP Successful | OTP 성공 | 자동 입력 → 칸·키보드가 사라지고 숫자가 한 줄로 합쳐져 커짐 → 완료 | 350 / 233 / 200 | 입력이 결과로 모핑 | 카카오 인증번호 확인 완료 |
| [S1586](https://60fps.design/shots/swiggy-purchased-loader-to-check-mark-animation) | Swiggy Purchased Loader to Check | 로더 → 체크 | 회전 로더 "Hold On!" → 완료 시 체크로 | 300 / 200 | 짧고 분명 | 우리 Loader→check 그대로(서버 확인 뒤) |
| [S1455](https://60fps.design/shots/uber-ride-verified-tick-in-sheet-animation) | Uber Ride Verified Tick in Sheet | 인증 완료 | PIN 점들이 체크로 모핑 | 333 / 350 | 입력 흔적이 결과로 | 기기 키 서명 완료 체크 |
| [S1167](https://60fps.design/shots/toss-accept-terms-check-interaction) | Toss Accept Terms Check | 약관 동의 | 버튼 탭 → 빨간 "필수" 라벨들이 파란 체크로 바뀌고 버튼 문구는 점 로딩 | 333 / 783 / 617 | 한 번에 모두 동의하되 결과가 보임 | 가입 약관(필수/선택 구분), **색만이 아니라 라벨 텍스트도 변경** |
| [S1634](https://60fps.design/shots/fuse-delete-wallet-sheet-checkbox-interaction) | Fuse Delete Wallet Sheet Checkbox | 위험 삭제 | 시트 안 체크박스 4개를 모두 체크해야 삭제 버튼 활성 | 133–167 | 되돌릴 수 없는 일에 읽게 만듦 | **볼트 전체 삭제/계정 삭제**(체크 2–3개로 축소) |
| [S1300](https://60fps.design/shots/honk-delete-account-sheet-stack-interaction) | Honk Delete Account Sheet Stack | 시트 스택 | 설정 화면이 줄며 뒤로 물러나고 위험 시트가 올라옴 | 733 / 800(15fps) | 맥락은 보이되 집중 | 계정 삭제 시트(뒤 화면 축소는 iOS 기본, 우리는 dim만) |
| [S1365](https://60fps.design/shots/family-button-to-sheet-button-morph-interaction) [S1379](https://60fps.design/shots/family-contextual-sheet-buttom-morph-interaction) [S1359](https://60fps.design/shots/family-button-morph-to-sheet-button-interaction) | Family Button ↔ Sheet Morph | 버튼 → 시트 | "Continue" 버튼 자체가 시트로 확장 | 417 / 167 | 다음 단계가 버튼에서 나옴 | **승인 카드 "자세히" → 시트**, 가입 "시작하기" → 시트(MOTION-SPEC §6-1과 동일) |
| [S1375](https://60fps.design/shots/family-dynamic-sheet-morph-interaction) [S1394](https://60fps.design/shots/family-sequence-of-sheets-vary-in-height-interaction) [S1368](https://60fps.design/shots/family-share-feedback-sheet-morph-interaction) | Family Dynamic / Varying Height Sheet | 단일 시트 다단계 | 단계마다 시트 높이·폭이 내용에 맞게 모핑, 내용은 교체 | 233–250 | 페이지 이동 없이 흐름 | 가입 시트·연결 시트·승인 시트의 단계 진행 |
| [S1402](https://60fps.design/shots/family-entering-values-to-confirm-screen-morph-interaction) | Family Entering Values to Confirm Morph | 입력 → 확인 | "Continue" 버튼이 확인 화면 요소로 모핑 | 400 / 533 | 입력과 확인이 연결 | 결제 승인: 금액 입력 → 확인 요약 |
| [S1391](https://60fps.design/shots/family-contextual-spinner-move-to-sheet-morph-interaction) [S1396](https://60fps.design/shots/family-spinner-move-to-bottom-navigation-on-confirm-transaction) | Family Contextual Spinner Move | 진행 위치 이동 | 확인 버튼 스피너가 시트/하단 내비로 이동해 진행 계속 표시 | 150(중앙값), 633–733 | 기다리는 동안 다른 일을 할 수 있음 | **승인 후 진행 표시가 Island로 이동**(사용자는 다른 화면으로 가도 됨) |
| [S2094](https://60fps.design/shots/circle-menu-dropdown-morph-interaction) | Circle Menu Dropdown Morph | pill → 모달 | 상단 주제 pill이 가운데 떠 있는 모달로 모핑 | 317(중앙값, 217–400) | 출처에서 자라남 | 둘러보기 카테고리 "전체 보기" |
| [S2091](https://60fps.design/shots/recollect-pro-bottom-sheet-to-page-interaction) | Recollect Pro Bottom Sheet to Page | 시트 → 페이지 | 작은 떠 있는 시트를 끌어올리면 전체 페이지로 | 500(중앙값) | 시트 디텐트 | 아티팩트 시트 medium → large 디텐트 |
| [S1317](https://60fps.design/shots/honk-chat-bubble-dynamic-resize-back-and-forth-interaction) | Honk Chat Bubble Dynamic Resize | 입력 말풍선 | 타이핑하는 동안 말풍선 크기가 글자마다 스프링으로 변함 | 267–733(15fps) | 살아 있는 입력 | **채택하지 않음**(입력 중 레이아웃이 계속 흔들림). 입력창은 줄이 바뀔 때만 높이 모핑 |
| [S1277](https://60fps.design/shots/notion-ai-sheet-intro-action-trail-transition) | Notion AI Sheet Intro Action Trail | AI 소개 시트 | 동작 pill 목록이 세로로 계속 흐름 | 루프 | 할 수 있는 일을 보여 줌 | 루프 대신 **정지된 예시 칩 3개** |
| [S0780](https://60fps.design/shots/family-approvals-empty-state-floating-lock-animation) | Family Approvals Empty State Floating Lock | 빈 상태 | 승인 대기 없음 화면에 자물쇠가 떠 있음 | 루프 | 비어 있어도 의미 | 승인 대기 0건: 정지 그림 + "승인할 일이 생기면 여기와 Island에 알려 드려요" |
| [S1972](https://60fps.design/shots/claude-code-empty-state-mascot-illustration-animation) | Claude Code Empty State Mascot | 빈 상태 | 마스코트 일러스트 애니메이션 | — | 성격 | 빈 대화 첫 화면(캐릭터 정지 포즈, 탭하면 한 번 반응) |
| [S1839](https://60fps.design/shots/craft-cursor-seek-liquid-glass-magnify-interaction) | Craft Cursor Seek Liquid Glass Magnify | 글래스 돋보기 | 커서를 끌면 글래스 돋보기가 커서에서 자라나 탄성 있게 따라옴 | — | 글래스가 기능(확대)을 가짐 | 긴 답변 텍스트 선택 핸들(웹은 OS 기본 유지 — 참고만) |
| [S1820](https://60fps.design/shots/quartr-selection-liquid-glass-pulse-interaction) | Quartr Selection Liquid Glass Pulse | 다중 선택 | 라디오 안쪽 점이 액체처럼 커지고 줄어듦 | — | 선택 피드백이 물질감 | 공유 대상·연결 앱 다중 선택 체크 |
| [S1683](https://60fps.design/shots/apple-measure-liquid-glass-level-interaction) | Apple Measure Liquid Glass Level | 글래스 방울 | 두 글래스 방울이 기울기에 따라 떠다니다 합쳐짐 | — | Apple 자체의 droplet merge | 우리 droplet split/merge 규칙의 Apple 레퍼런스 |
| [S1640](https://60fps.design/shots/perplexity-conversation-word-sentence-audio-interaction) | Perplexity Word Highlight Synced to Audio | 음성 동기 텍스트 | 읽는 단어가 색으로 강조, 문장 교체 시 위로 살짝 | — | 들으면서 읽기 | 통화 자막: 지금 말하는 문장만 진하게(색 + 굵기) |
| [S1526](https://60fps.design/shots/grok-ai-voice-download-spinner-loader-animation) | Grok AI Voice Download Spinner | 음성 준비 | 입력·카드가 내려가고 우상단에 스피너 | — | 준비 중 표시 | 첫 통화 시 음성 모델 준비(진행률을 알면 막대) |
| [S1164](https://60fps.design/shots/perplexity-number-flip-animation) | Perplexity Number Flip | 카운터 | "1/10 → 2/10" 스플릿 플랩 플립 | — | 남은 횟수가 바로 보임 | 무료 한도 카운터(오도미터) |
| [S0067](https://60fps.design/shots/arc-search-ai-generation-loader) | Arc Search AI Generation Loader | 생성 진행 | 키보드가 내려가고 "Reading 6 web pages" 진행 문구 + **출처 URL 목록이 하나씩** 들어옴(배경은 전체 화면 그라디언트 맥동) | — | 무엇을 읽는지 보여 주면 기다림이 납득됨 | **도구 칩 펼침에 출처 목록**(웹 검색·메일 읽기). 그라디언트 배경은 금지 |
| [S0959](https://60fps.design/shots/remy-ai-analysis-checklist-animation) [S0961](https://60fps.design/shots/remy-ai-analysis-chat-interaction) | Remy AI Analysis Checklist / Chat | 단계 체크리스트 | 마스코트가 헤더로 줄고, 분석 항목 목록이 스태거로 등장해 하나씩 완료 / 분석 결과 말풍선·그래프가 순차로 들어오며 자동 스크롤 | — | 긴 분석의 단계가 보임 | 긴 작업(브리핑 생성 등)의 단계 목록 — 자동 스크롤은 사용자가 바닥에 있을 때만(§5-3) |
| [S0957](https://60fps.design/shots/remy-ai-chat-interaction) | Remy AI Chat | 타이핑 표시 → 말풍선 | 점 3개 표시가 커지며 답 말풍선으로 모핑(말풍선 등장은 springy overshoot) | — | 자리표시와 답이 같은 요소 | **자리표시 한 줄이 첫 문장으로 모핑**(점 루프 대신), 오버슈트는 빼기 |
| [S1301](https://60fps.design/shots/honk-typing-pill-slide-interaction) | Honk Typing Pill Slide | 상대 입력 중 | 헤더 오른쪽에서 "Taylor is typing" pill이 들어오며 제목을 밀어냄, 끝나면 되돌아감 | — | 상태가 헤더 안에서만 | 친구 대화에서 상대(사람·상대 모시) 입력 중 표시 |
| [S0558](https://60fps.design/shots/focuspomo-hold-to-stop-interaction) | FocusPomo Hold to Stop | 길게 눌러 중단 | 길게 누르면 문구 위 진행 막대가 차고, 다 차면 중단 | — | 실수 방지 | 예약된 일 "지금 중단"(반복 작업 전체 중단)에만 |
| [S1025](https://60fps.design/shots/grok-new-chat-suggestions-pop-interaction) | Grok New Chat Suggestions Pop | 제안 자동 순환 | 입력창 위 제안 pill이 **타이머로** 주기적으로 바뀜 | 루프 | — | **반면교사**: 읽는 중에 바뀜. 제안은 새 대화 열 때만 갱신 |
| [S0052](https://60fps.design/shots/chatgpt-listening) [S0009](https://60fps.design/shots/arc-search-long-press-assistant) | ChatGPT Listening / Arc Long Press Assistant | 음성 진입 | 연결 중 회전 그라디언트 링 → 준비되면 흰 원, 듣는 동안 맥동 / 길게 누르면 페이지가 dim+blur, 전체 음성 오버레이 | — | 연결 중과 준비됨을 구분 | 통화 "연결 중"과 "연결됨"을 **모양으로 구분**(링 → 원), 그라디언트·blur는 빼기 |

### 2-6. Motion(M)·App Sites(A) 기존 사례 중 계속 유효한 것(1차 조사 재인용)

| ID | 무엇 | 우리 앱 매핑 |
|---|---|---|
| [M067](https://60fps.design/motion/conduit-by-hex) Conduit | 글래스 UI 카드 | 글래스는 컨트롤 층에만, 콘텐츠 카드는 종이 |
| [M062](https://60fps.design/motion/wabi-by-studiodumbar) Wabi | 글래스 구·유기적 스프링 | 온보딩 캐릭터 재질 참고 |
| [M027](https://60fps.design/motion/brightfield-by-justified-studio) Brightfield | "Thinking…" 배지 | Island 상태 문구 |
| [M010](https://60fps.design/motion/indicium-ai-by-justified-studio) Indicium | pill 배지 크기 변경 | 도구 칩 상태 모핑 |
| [M059](https://60fps.design/motion/elevenlabs-by-thru) ElevenLabs | 지우고 다시 쓰기 | 답변 "다시 생성" 시 기존 텍스트가 줄 단위로 사라지고 새로 들어옴 |
| [M072](https://60fps.design/motion/univers-by-pentagram) Univers | 궤도 점 → 로딩 링 | 활동 링 |
| [M036](https://60fps.design/motion/alipay-by-further) Alipay+ | QR → 잔액 → 체크 | 결제 승인 결과 |
| [M050](https://60fps.design/motion/superhuman-by-smith-diction) Superhuman | 아이콘 상태 모핑 | 전송 ↔ 멈추기 아이콘 모핑 |
| [M081](https://60fps.design/motion/machinex-by-koto) MachineX, [M021](https://60fps.design/motion/olla-by-recent) Olla, [M025](https://60fps.design/motion/summ-by-accompany) Summ | 숫자 플립·티커·표 숫자 | 오도미터, `tabular-nums` |
| [M045](https://60fps.design/motion/cofounder-by-altalogy) Cofounder | pill 선택이 그려짐 | 세그먼트 thumb |
| [M063](https://60fps.design/motion/headspace-by-metalab) Headspace | 차분한 캐릭터 | 캐릭터 성격(차분, 과장 없음) |
| [M040](https://60fps.design/motion/replit-by-oddfellows) Replit | 메타볼 연결 | droplet merge |
| [M019](https://60fps.design/motion/work-with-island-by-bruno) Work With Island | 소리 파형 맥동 | 통화 중 Island 레벨 막대(실제 음량) |
| [A051](https://60fps.design/appsites/aave-tab-scale-interaction) Aave | 탭 스케일 ≈183ms | 탭 전환 체감 길이 기준 |
| [A070](https://60fps.design/appsites/jace-thumbnail-hero-transition) Jace | 카드 → 상세 ≈367ms | 카드→시트 모핑 길이 기준 |
| [A045](https://60fps.design/appsites/interface-craft-card-stack-swipe-interaction) Interface Craft | ≈633ms 큰 전환 | camera 역할 상한(t99 633ms)과 일치 |
| [A044](https://60fps.design/appsites/uncommon-image-generating-blur-animation) Uncommon, [A004](https://60fps.design/appsites/skiper-ui-accordion-interaction) Skiper, [A041](https://60fps.design/appsites/shopify-winter-26-text-animation) Shopify | 117–133ms 마이크로 | press·hover 길이 기준 |

## 3. 패턴 카탈로그 — AI 에이전트 앱용

> 각 패턴: **최고 사례 → 메커니즘 → 타이밍(역할) → 비용 → 접근성 쌍둥이**(reduced motion·reduced transparency·스크린 리더에서 같은 정보를 주는 방법). 역할 이름은 `motion/springs.ts`의 `ROLES`.

### 3-0. 먼저 정할 것: 에이전트 상태 어휘 하나

60fps의 좋은 AI 사례([S2043](https://60fps.design/shots/monogram-pulse-sweep-chat-response-reveal-interaction) [S2047](https://60fps.design/shots/monogram-pulse-calendar-connect-reveal-interaction) [S2050](https://60fps.design/shots/monogram-tap-and-hold-mic-liquid-blur-pulse-interaction) [S1848](https://60fps.design/shots/eimi-generating-card-preview-morph-pop-scale-in-sheet-animation))는 공통적으로 **"지금 무엇을 하는지"를 한 곳에서, 실제 단계 이름으로** 말한다. 나쁜 사례(§6-1·2)는 상태와 무관한 빛·문구 루프를 쓴다. 우리 앱은 Island·컴포저·도구 칩·탭 바 액세서리가 **같은 상태 어휘**를 공유해야 한다. 현재 코드(`app/island.ts`)의 모드는 `idle | working | done | call` 네 개뿐이다.

| 상태 | 근거 이벤트(SSE 등) | Dynamic Island | 컴포저 | 스레드 | 스크린 리더(live polite) |
|---|---|---|---|---|---|
| `idle` | 스트림 없음 | 126×37 검은 pill, **아무것도 움직이지 않음** | 휴식 pill(+ · 마이크 · 키보드) | — | — |
| `listening` | 마이크 활성 | 넓어짐 + 레벨 막대 5개(**실제 입력 음량**) + "듣는 중" | 마이크가 원으로 모핑, 실시간 받아쓰기 | — | "듣는 중" |
| `thinking` | 전송 후 첫 토큰 전 | 넓어짐 + "생각하는 중"(1s 뒤) | 전송 버튼 → **멈추기**(사각형) 모핑 | 150ms 뒤 자리표시 한 줄(정지) | (1s 뒤) "생각하는 중" |
| `tool:<name>` | `tool_call` 시작 | "카카오톡 읽는 중"(콘텐츠 스왑) | 멈추기 유지 | 도구 칩(활동 링) | "카카오톡 읽는 중" |
| `streaming` | `text` 토큰 | "답하는 중", 레벨 막대 = **토큰 속도** | 멈추기 유지 | 줄 단위 2px rise | 문장 끝마다 읽기 |
| `awaiting_approval` | `approval_required` | 넓어짐 + 자물쇠 아이콘 + "승인이 필요해요"(탭 → 해당 카드로 스크롤) | 일반 입력 가능(대기 중에도) | 승인 카드 | "승인이 필요해요: 메일 보내기" (assertive 아님) |
| `done` | `done` | 체크가 그려짐(`snap`) → 1.6s 뒤 `idle` | 멈추기 → 전송(빈 입력이면 마이크) | 도구 칩들이 "N단계 수행" pill로 접힘 | "완료했어요" |
| `error` | `error` / 15s 무응답 | 빨간 점 + "다시 시도할까요?"(탭 → 다시 시도) | 입력 보존 | 실패한 말풍선에 "다시 보내기" | "보내지 못했어요. 다시 시도할 수 있어요" |
| `offline` | `navigator.onLine=false` | 점선 원 아이콘 + "오프라인" | 전송 비활성 + 이유 | 대기 중 메시지에 시계 아이콘 | "오프라인이에요" |
| `call` | 통화 연결 | 아바타 + 타이머(tabular) + 레벨 막대 | 숨김(Island가 컨트롤) | 자막 | 통화 시간은 읽지 않음 |

- **규칙 1**: Island는 상태가 바뀔 때만 모양이 바뀐다. `idle`에서 파형·점 맥동 **금지**(현재 QA 캡처 v4-chat의 idle 상태 청록 점 + 파형은 가짜 활동이다).
- **규칙 2**: 문구는 서버가 준 도구 이름에서 만든다(`tool.name → "OO하는 중"` 매핑 표). 매핑이 없으면 "작업하는 중", **임의 문구 순환 금지**.
- **규칙 3**: 2초 넘게 같은 상태면 경과 시간("12초")을 붙인다. 15초면 `error`로 넘어가지 않고 "오래 걸리고 있어요 · 멈추기"를 보여 준다(organic-motion §9.1 "~15s = failure"는 무응답 기준. 도구가 진행 이벤트를 보내는 동안은 실패가 아니다).

### 3-1. 스트리밍 텍스트

- **최고 사례**: [S2043](https://60fps.design/shots/monogram-pulse-sweep-chat-response-reveal-interaction) Monogram(응답이 구조화된 블록·아이콘 목록으로 들어옴), [M059](https://60fps.design/motion/elevenlabs-by-thru) ElevenLabs(지우고 다시 쓰기), [S1640](https://60fps.design/shots/perplexity-conversation-word-sentence-audio-interaction) Perplexity(읽는 위치 강조).
- **메커니즘**: 토큰 버퍼 → rAF당 1회 커밋 → **어절 경계까지만** 화면에 반영 → 새 줄이 생기면 그 줄만 `y: 2→0, opacity .0→1`(`fade` 역할). 블록(목록·표·코드)은 닫힐 때 한 번에. "다시 생성"은 기존 문단이 줄 단위로 위에서부터 사라지고(나감 120ms) 새 텍스트가 같은 자리에서 시작.
- **타이밍**: 줄 등장 `fade`(t90 149ms). 커서·점 3개 깜빡임 없음.
- **비용**: 낮음(DOM 텍스트, transform/opacity만). 위험은 마크다운 재파싱 — 증분 파싱 필수(§5-3).
- **접근성 쌍둥이**: reduced motion = rise 없이 즉시. 스크린 리더 = 문장 단위 polite. 확대 글꼴 200%에서도 줄 단위 등장이 레이아웃을 밀지 않는지(CLS 0).
- **금지**: 글자 단위 타자기, 그라디언트 응답 배경([S1954](https://60fps.design/shots/google-gemini-response-gradient-animation)), 점 3개 무한 루프.

### 3-2. 도구 활동 시각화

- **최고 사례**: [S2047](https://60fps.design/shots/monogram-pulse-calendar-connect-reveal-interaction) Monogram("Searching your Calendar" pill → 권한 카드), [N014](https://60fps.design/snippets/see-all-menu-expand-interaction) Captions(요약 → 전체 펼치기, spring .36/.90), [M010](https://60fps.design/motion/indicium-ai-by-justified-studio) Indicium(pill 배지 크기 변경), [S1391](https://60fps.design/shots/family-contextual-spinner-move-to-sheet-morph-interaction) Family(진행 표시가 하단으로 이동해 계속 보임).
- **메커니즘**: 도구 칩 하나 = 한 요소의 상태 모핑(실행 중: 활동 링 + "OO 읽는 중" → 완료: 링이 채워지고 체크 그려짐 → 오류: 느낌표 + "다시 시도"). 끝나면 칩들이 **"4단계 수행 · 12초" pill 하나로 접히고**, 탭하면 `N014`처럼 펼쳐져 각 단계의 입력·결과 요약(무엇을 읽었는지, 무엇을 보냈는지)이 보인다.
- **타이밍**: 칩 상태 모핑 `snap`(163ms), 접힘/펼침 `morph`(232ms), 체크 그리기 `snap`, 칩 등장 스태거 30ms×최대 4.
- **비용**: 낮음. 활동 링은 CSS `conic-gradient` 회전 대신 **SVG stroke-dashoffset 회전 1개**(뷰포트당 루프 1개 규칙, 진행 중에만).
- **접근성 쌍둥이**: 칩마다 `aria-label="카카오톡 읽기, 진행 중"` → 상태 변화 시 polite 알림 1회. reduced motion = 링 회전 대신 "진행 중" 텍스트, 체크는 즉시.

### 3-3. 에이전트 존재(Dynamic Island)

- **최고 사례**: [S2043](https://60fps.design/shots/monogram-pulse-sweep-chat-response-reveal-interaction)(하단 pill이 듣기·생각 상태가 됨), [S2050](https://60fps.design/shots/monogram-tap-and-hold-mic-liquid-blur-pulse-interaction)(누르면 원, 떼면 "Searching the internet…" pill), [M019](https://60fps.design/motion/work-with-island-by-bruno) Work With Island(소리 파형), [M027](https://60fps.design/motion/brightfield-by-justified-studio) Brightfield("Thinking…" 배지).
- **메커니즘**: §3-0 표. 크기 변경은 `morph`, 문구는 콘텐츠 스왑(나감 120 → +60 → 들어옴), 레벨 막대는 실제 값(음량 또는 토큰 속도, 0.1s 평활) — 값이 0이면 막대도 0.
- **타이밍**: 상태 전환 `morph` t90 232ms. 배너로 늘어남 `morph`, 2.0–4.0s 유지(문구 길이 × 60ms + 1.5s), 수축 `morph`.
- **비용**: 낮음(불투명 검정, blur 없음).
- **접근성 쌍둥이**: Island는 `role="status"`, 탭하면 해당 위치로 이동하는 `<button>`. reduced motion = 크기 즉시 변경, 문구만 교체.

### 3-4. 승인·확인

- **최고 사례**: [N022](https://60fps.design/snippets/delete-to-confirm-button-interaction) Delete→Confirm(같은 자리 2단계), [N029](https://60fps.design/snippets/cancel-button-expand-to-confirm-interaction) Cancel→Confirm, [N007](https://60fps.design/snippets/hold-to-commit-button-interaction) Hold to Commit(2.0s linear 채움), [S1634](https://60fps.design/shots/fuse-delete-wallet-sheet-checkbox-interaction) Fuse(체크박스 전부 체크해야 활성), [S1402](https://60fps.design/shots/family-entering-values-to-confirm-screen-morph-interaction) Family(입력 → 확인 요약 모핑), [S2112](https://60fps.design/shots/run-receipt-signature-interaction) Run Receipt(서명 결과가 원래 문맥에 렌더), [M036](https://60fps.design/motion/alipay-by-further) Alipay+(QR → 잔액 → 체크).
- **메커니즘(위험도 3단계)**:

| 위험도 | 예 | 확인 방식 | 결과 |
|---|---|---|---|
| 낮음(되돌릴 수 있음) | 일정 추가, 메모 저장 | 확인 없음. **5초 실행 취소 배너**(Island에서 내려옴) | 서버 확인 뒤 체크 |
| 중간(외부로 나감) | 메시지·메일 보내기, 친구 초대 | 승인 카드: **보낼 내용 전문 미리보기**(받는 사람·본문·첨부) + "보내기"(주 버튼) / "고치기" / "취소". "자세히"는 `N017` 시트 확장 | 기기 키 서명 → 로더 → 서버 확인 → 체크 → 카드가 "보냄 · 오후 3:12" 영수증 pill로 접힘 |
| 높음(돈·삭제·권한) | 결제, 계정·볼트 삭제, 정보 공개 범위 확대 | 금액·대상 요약 + **길게 눌러 승인 1.2s**(`N007`보다 짧게) **또는** "승인" 탭 → 같은 자리 "정말 결제할까요? 39,000원" 확인(`N022`) — 두 방식 모두 항상 제공 | 위와 같음 + 영수증에 서명 키 지문(앞 8자) |

- **타이밍**: 확인 확장 `snap`(N022 t90 179ms와 동급), 길게 누르기 채움 linear 1.2s(손 떼면 `snap`으로 되감기), 영수증 접힘 `morph`.
- **비용**: 낮음.
- **접근성 쌍둥이**: 길게 누르기는 **스크린 리더·스위치 제어에서 불가능**하므로 2단계 탭이 반드시 같은 자리에 있어야 한다(VoiceOver 사용자 동작 "두 번 탭 후 길게"에 의존하지 않음). 승인 카드에 `aria-describedby`로 보낼 내용 요약 연결.
- **HIG 근거**: generative-ai "people in control", "permission before irreversible tasks". MOTION-SPEC §6-2 "approval cards (two buttons, approve = primary)"는 **중간 위험에만** 맞다 — 낮음·높음 단계를 추가해야 한다.

### 3-5. 자격 증명·보안 입력

- **최고 사례**: [N011](https://60fps.design/snippets/hide-sensitive-number-interaction) Hide Sensitive Number(easeInOut .15), [N010](https://60fps.design/snippets/otp-input-pulse-fill-success-interaction) / [S1220](https://60fps.design/shots/toss-otp-successful-animation) Toss OTP(칸 → 한 줄로 합쳐짐), [S1375](https://60fps.design/shots/family-dynamic-sheet-morph-interaction) Family View Private Key 시트(시트 높이 모핑으로 경고 → 내용), [S1455](https://60fps.design/shots/uber-ride-verified-tick-in-sheet-animation) Uber PIN 점 → 체크, [S1253](https://60fps.design/shots/finma-private-secure-lock-animation) Finma(데이터 카드가 자물쇠로 모핑 — 온보딩 설명용).
- **메커니즘**: 스레드 안 자격 증명 카드 → 탭하면 **불투명 시트**(글래스 아님)로 확장: 서비스 로고 + "모시는 이 비밀번호를 볼 수 없어요(기기에서 암호화)" + 입력 + 보관 기간 세그먼트(1시간/1일/7일/30일/계속, ≤5개 규칙 충족) → 저장 → 로더 → 서버 확인 → 카드가 "저장됨 · 7일" pill로 수축.
- **보안 동작**: `visibilitychange`/앱 전환 시 입력값과 볼트 화면 **즉시 블러 + 가림**(애니메이션 없음), 복귀 시 다시 가린 상태. `autocomplete="current-password"`/`one-time-code`, 붙여넣기 허용.
- **타이밍**: 시트 확장 `morph`, 가리기/보기 150ms(`N011`), pill 수축 `morph`.
- **접근성 쌍둥이**: 보기 토글 `aria-pressed`, 가린 값은 "숨김"으로 읽음. reduced transparency에서 시트·카드 불투명(이미 불투명).

### 3-6. 음성·통화

- **최고 사례**: [S2050](https://60fps.design/shots/monogram-tap-and-hold-mic-liquid-blur-pulse-interaction) / [N024](https://60fps.design/snippets/tap-to-hold-button-pulse-morph-interaction) Monogram(탭 vs 길게), [S1945](https://60fps.design/shots/avec-hold-and-speak-interaction) Avec(녹음 중 상태 명확), [S2039](https://60fps.design/shots/chatgpt-voice-blob-gradient-interaction) ChatGPT(닫힘 300ms), [S1640](https://60fps.design/shots/perplexity-conversation-word-sentence-audio-interaction) Perplexity(읽는 위치), [M019](https://60fps.design/motion/work-with-island-by-bruno)(실제 파형), [S1289](https://60fps.design/shots/honk-call-connect-pulse-animation) Honk 통화 연결(아바타 슬라이드).
- **메커니즘**: 컴포저 통화 원 → Island로 늘어남 → 통화 카드(MOTION-SPEC §6-10 유지). 캐릭터 반응은 **실제 음량**만(가짜 숨쉬기 아님). 자막은 지금 문장만 굵게.
- **타이밍**: 컴포저 → Island `morph`, Island → 카드 `camera`(t90 372ms), 종료 카드 → Island ≤300ms(`morph` t99 329ms).
- **비용**: 중간(음량 분석 `AnalyserNode` 30Hz면 충분).
- **접근성 쌍둥이**: 자막 항상 켬, 음소거·종료 버튼 64px 이상, 통화 상태 변화 polite 알림. reduced motion = 캐릭터 정지, 레벨 막대만.

### 3-7. 일 갤러리(둘러보기)

- **최고 사례**: [S2126](https://60fps.design/shots/plasma-duo-style-bottom-sheet-open-interaction) Plasma(카드 → 상세 시트), [A070](https://60fps.design/appsites/jace-thumbnail-hero-transition) Jace(썸네일 → 히어로 ≈367ms), [S2094](https://60fps.design/shots/circle-menu-dropdown-morph-interaction) Circle(pill → 모달), [S1710](https://60fps.design/shots/wabi-chat-suggestion-swipe-cards-carousel-interaction) Wabi(제안 문구가 입력으로 이동), [S1567](https://60fps.design/shots/queue-ask-ai-chat-random-prompt-interaction) Queue(제안 → 전송 + 크레딧 감소).
- **메커니즘**: 일 카드 탭 → 카드가 시트로 모핑 → 시트에 **무엇을·필요한 연결·예상 시간·무료 한도 소모·예시 결과** → "맡기기"(주 버튼, 화면 유일 강조색) → 시트가 컴포저로 수축하며 문구가 입력됨([S1710](https://60fps.design/shots/wabi-chat-suggestion-swipe-cards-carousel-interaction)) → 바로 전송(낙관적 말풍선).
- **타이밍**: 카드 → 시트 `morph`(시트는 r38까지), 시트 내용 +60ms, 시트 → 컴포저 `morph`.
- **비용**: 낮음(clip-path + transform).
- **접근성 쌍둥이**: 카드는 `<button>`, 시트 `role="dialog"` + 포커스 트랩. reduced motion = 시트 즉시 등장(페이드 120ms).

### 3-8. 아티팩트·문서 뷰어

- **최고 사례**: [S1541](https://60fps.design/shots/grok-pull-down-to-go-back-interaction) Grok(아래로 끌어 닫으면 그리드 자리로), [S2091](https://60fps.design/shots/recollect-pro-bottom-sheet-to-page-interaction) Recollect(시트 → 페이지 디텐트), [A096](https://60fps.design/appsites/apple-homeview-zoom-scroll-interaction)(하나 → 여럿 줌아웃), [S1848](https://60fps.design/shots/eimi-generating-card-preview-morph-pop-scale-in-sheet-animation) Eimi(생성 중 점선 자리표시 → 카드, Stop → Done).
- **메커니즘**: 보관함 카드 → medium 디텐트 시트(요약·공유·내보내기) → 끌어올리면 large(전체 문서). 아래로 끌어 닫으면 카드 자리로 수축. 생성 중인 아티팩트는 **점선 테두리 + 단계 이름**, 완료되면 같은 카드가 채워지고 "멈추기" 버튼이 "열기"로 모핑.
- **타이밍**: 시트 디텐트 `morph`, 끌어 닫기 = 손 위치 그대로 + 놓으면 속도 반영 `camera`.
- **접근성 쌍둥이**: 디텐트 전환 버튼(그래버에 `aria-label="크게 보기"`), Esc 닫기.

### 3-9. 목록·설정

- **최고 사례**: [S1375](https://60fps.design/shots/family-dynamic-sheet-morph-interaction) / [S1394](https://60fps.design/shots/family-sequence-of-sheets-vary-in-height-interaction) Family(한 시트 안 다단계), [N022](https://60fps.design/snippets/delete-to-confirm-button-interaction)(행 안 2단계 삭제), [S1820](https://60fps.design/shots/quartr-selection-liquid-glass-pulse-interaction) Quartr(다중 선택 방울), [N015](https://60fps.design/snippets/list-fade-up-from-down-interaction)(첫 방문 목록 등장).
- **메커니즘**: iOS 인셋 그룹 목록. 스위치는 **목록 행에만**(HIG). 행 → 상세는 `camera` 수평 슬라이드 + 행 라벨이 큰 제목으로 공유 요소(MOTION-SPEC §6-6 유지). 삭제는 행 스와이프 또는 행 안 `N022`.
- **타이밍**: 행 press = 배경 즉시(0ms), 상세 `camera`, 토글 `snap`.
- **접근성 쌍둥이**: 스위치 `role="switch"` + `aria-checked`, 행 전체가 탭 영역(44px 이상).

### 3-10. 빈 상태

- **최고 사례**: [S0780](https://60fps.design/shots/family-approvals-empty-state-floating-lock-animation) Family 승인 빈 상태(자물쇠), [S1972](https://60fps.design/shots/claude-code-empty-state-mascot-illustration-animation) Claude Code(마스코트), [S1935](https://60fps.design/shots/fold-cards-empty-state-animation) / [S1934](https://60fps.design/shots/fold-spaces-empty-state-animation) Fold(카드·공간 빈 상태), [S2060](https://60fps.design/shots/district-no-internet-connection-empty-state-animation) / [S1933](https://60fps.design/shots/district-something-went-wrong-empty-state-animation) District(오프라인·오류).
- **메커니즘**: 그림 1개(정지) + 무엇이 여기 생기는지 한 문장 + **실제 행동 1개**("{모시 이름}에게 문서 만들어 달라고 하기" → 컴포저에 예시 문구 입력). 그림은 처음 나타날 때 한 번만 `fade` + 4px rise.
- **타이밍**: `fade` t90 149ms, 루프 없음.
- **접근성 쌍둥이**: 그림은 `aria-hidden`, 문장과 버튼만 읽음.

### 3-11. 알림

- **최고 사례**: MOTION-SPEC §3 Banner(Island에서 내려옴) + [S1484](https://60fps.design/shots/cobot-toast-expand-shrink-interaction) Cobot(오류 토스트가 점으로 줄어 사라짐), [N005](https://60fps.design/snippets/forward-toast-icon-animation) Telegram 전달 토스트 아이콘(easeOut .15/.20).
- **메커니즘(HIG 중단 수준)**: passive(조용히 목록에만) / active(배너) / time-sensitive(예약된 일 시각, 배너 + 소리 허용) / critical 없음. 앱 안 배너는 Island에서 늘어나 2–4s 유지, 위로 밀어 닫기, 탭하면 해당 스레드. 동시에 1개, 나머지는 대기열.
- **타이밍**: 늘어남·수축 `morph`. 유지 = 문구 길이 기반(§3-3).
- **접근성 쌍둥이**: `role="status"`(오류만 `role="alert"`), 유지 시간 동안 포커스·호버하면 멈춤.

### 3-12. 온보딩

- **최고 사례**: [S2079](https://60fps.design/shots/wabi-soothing-loading-fade-reveal-animation) Wabi(실제 단계 문구 교체), [S1710](https://60fps.design/shots/wabi-chat-suggestion-swipe-cards-carousel-interaction)(제안 카드로 첫 부탁), [S2137](https://60fps.design/shots/plasma-card-setup-animation) Plasma(서버 완료 이벤트에 전환 묶기), [S1167](https://60fps.design/shots/toss-accept-terms-check-interaction) Toss(약관 일괄 동의 결과가 보임), [S1365](https://60fps.design/shots/family-button-to-sheet-button-morph-interaction) Family(버튼 → 시트).
- **메커니즘**: 스플래시 없음 → 캐릭터 + "나만의 모시를 만나보세요" + "시작하기" → 가입 시트(이름·모시 이름만 먼저, 소셜 로그인 우선, 비밀번호는 이메일 가입일 때만) → 서버 확인 → 시트가 상단바 아바타로 수축 → 빈 채팅에 **제안 칩 3개**(연결이 필요 없는 일: "내일 날씨 알려 줘", "이번 주 할 일 정리해 줘", "점심 메뉴 골라 줘"). 권한(알림·연결)은 **처음 필요할 때** 그 자리에서.
- **타이밍**: 시트 `morph`, 수축 `morph`, 칩 등장 스태거 30ms×3(첫 방문만).
- **접근성 쌍둥이**: 캐릭터는 장식(`aria-hidden`), 시트 포커스 트랩, 소셜 로그인 버튼에 서비스 이름.

### 3-13. 검색

- **최고 사례**: [S0821](https://60fps.design/shots/apple-pull-down-for-spotlight-interaction) Apple Spotlight(아래로 끌면 배경이 끄는 양만큼 흐려짐), [S1476](https://60fps.design/shots/google-ai-mode-search-morph-interaction) Google AI Mode(검색바 → AI 모드, 되돌림), [S1261](https://60fps.design/shots/airbnb-search-tab-interaction) Airbnb(검색바 → 전체 오버레이).
- **메커니즘**: MOTION-SPEC §3 Spotlight 유지(초성, I-beam 1Hz). 추가: 결과 맨 아래 **"모시에게 '…' 물어보기"** 행 → 누르면 검색바가 컴포저로 모핑([S1476](https://60fps.design/shots/google-ai-mode-search-morph-interaction)). 최근 검색·추천은 입력 전부터. 결과 갱신 디바운스 150ms(HIG).
- **타이밍**: 결과 행 `snap`(layout), 검색바 → 컴포저 `morph`.
- **접근성 쌍둥이**: `role="combobox"` + `aria-activedescendant`, 결과 수 polite("3개 결과").

### 3-14. 차트·숫자

- **최고 사례**: [N008](https://60fps.design/snippets/line-graph-morph-interaction) Family 그래프 모핑(.32/.82), [N031](https://60fps.design/snippets/graph-scrub-highlight-glow-interaction) Revolut 스크럽, [N006](https://60fps.design/snippets/number-flip-with-reflection-interaction) / [S1164](https://60fps.design/shots/perplexity-number-flip-animation) 숫자 플립, [M025](https://60fps.design/motion/summ-by-accompany) Summ(표 숫자), [S2135](https://60fps.design/shots/runmo-days-counter-interaction) Runmo 티커.
- **메커니즘**: MOTION-SPEC §3 Chart·Counters 유지. 추가: 기간 전환은 막대 높이만 모핑(새 막대 생성 아님), 스크럽은 손가락 위치 즉시(스프링 없음, 툴팁만 `snap`으로 따라옴), 숫자 티커는 **모션블러 없이** 세로 이동.
- **타이밍**: 막대 첫 등장 `morph` + 30ms 스태거(세션당 1회), 기간 전환 `morph`, 오도미터 35ms/자리.
- **접근성 쌍둥이**: 차트마다 숨은 표(`<table class="sr-only">`) 또는 `aria-label="지난 7일 사용량, 최고 화요일 18%"`, 숫자는 `font-variant-numeric: tabular-nums`.

## 4. 페이지별 개선안

> 표기: **P0** = 이번 주기 안에(체감 품질·신뢰에 직접), **P1** = 다음 주기, **P2** = 여유 있을 때. 영역 (a) 모션 (b) UI/UX·정보 구조 (c) 인터페이스·컨트롤 (d) 반응 속도 (e) 사용성·접근성. 역할/타이밍은 `springs.ts` 역할 이름과 t90. 근거는 §2 ID. 수용 검사는 **PW**(Playwright 자동) 또는 **눈**(사람이 보고 판정).
>
> "현재"는 `MOTION-SPEC.md` §6 문구와 `docs/qa/` 캡처(v2–v4) 기준이다. 코드는 지금 다시 쓰이는 중이라(11-11 스냅샷에 `screens/`·`TabBar`·`DynamicIsland` 파일이 없음) 파일 단위 지적은 §7에서 컴포넌트 이름으로 한다.

### 4-0. 모든 화면 공통

**문제·위험(QA 캡처에서 확인)**

- 탭 전환 중간 프레임(`v3-midswitch`)에서 **페이지 전체가 블러된 채 비어 보인다.** 나감 120ms + 간격 60ms 동안 읽을 수 있는 것이 없다. 하루 수십 번 하는 동작에 180ms의 빈 화면은 organic-motion "many per hour → t90 ≤ ~230ms" 예산을 혼자 다 쓴다. 전체 화면 `filter: blur()` 애니메이션은 중급 안드로이드에서 프레임을 떨어뜨린다(§5-4).
- 같은 캡처에서 탭 라벨이 **드롭렛이 도착하기 전에** 강조색으로 바뀐다(상태와 모양이 따로 논다).
- Island idle에 청록 점 + 파형이 항상 보인다 → 아무 일도 안 하는데 "일하는 중"으로 읽힌다(신뢰 문제).
- 한 화면에 강조색이 여러 곳(상단 "초대", 통화 버튼 채움, "부탁하기" ×4, FAB + 파란 글로우).
- 채팅 화면 하단에 컴포저 + 탭 바가 쌓여 화면 높이의 약 17%를 차지한다.
- 탭 바 뒤로 지나가는 콘텐츠가 거의 없어서 글래스가 "회색 판"처럼 보인다([S2099](https://60fps.design/shots/netflix-poster-reflection-on-bottom-tabs-interaction) Netflix처럼 콘텐츠가 아래로 흘러야 렌즈가 의미 있음).

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 0-1 | (a)(d) | **탭 전환: 나감 없음, 전체 화면 블러 없음.** 이전 페이지는 즉시 제거, 새 페이지는 `opacity 0→1` 180ms linear + `y 6→0` `camera`. 드롭렛은 two-edge 그대로. 블러 들어옴/나감은 **뷰포트 25% 이하 컨테이너**(Island 문구, 칩, 버튼 라벨)에만 | P0 | camera(t90 372, 체감은 opacity 180ms가 결정) | react-console 라우트 레시피, [A051](https://60fps.design/appsites/aave-tab-scale-interaction) ≈183ms, `v3-midswitch` | PW: 탭 클릭 후 50ms 시점 새 화면 h1 `opacity > 0.2`. 전환 중 매 rAF마다 `getComputedStyle(el).filter`에 blur가 있는 요소의 면적 합 ≤ 뷰포트 25% |
| 0-2 | (a) | 탭 라벨·아이콘 색 변경은 드롭렛 **선행 가장자리가 그 탭에 닿는 순간**(또는 드롭렛 `trail` 안착 50% 지점) | P1 | lead/trail | MOTION-SPEC §3 two-edge | PW: 클릭 직후 1프레임째 새 탭 라벨 색이 아직 이전 색 |
| 0-3 | (b) | **강조색은 화면당 1곳**(그 화면의 주 행동). "초대", "부탁하기", 통화 버튼, FAB는 중립(채움 `--fill`, 글자 `--label`). FAB 글로우 제거 | P0 | — | MOTION-SPEC §0, §6-7 | PW: 화면마다 `[data-accent]` 또는 강조색 배경 요소 수 ≤ 1 |
| 0-4 | (a)(e) | **Island idle = 정지.** §3-0 상태 어휘 10개를 `app/island.ts`에 추가(`listening`, `thinking`, `tool`, `awaiting_approval`, `error`, `offline`) | P0 | morph | §3-0, HIG generative-ai | PW: 로드 3초 뒤 idle에서 `document.getAnimations().filter(a=>a.playState==='running').length===0` + rAF 콜백 수 0(루프 감시 스크립트) |
| 0-5 | (b)(c) | 상단바: **한 장의 넓은 캡슐 → 떨어진 글래스 3개**(왼쪽 메뉴 원 44, 가운데 아바타+이름 캡슐, 오른쪽 동작 원 44). 동작은 아이콘(사람+), 라벨은 `aria-label` | P1 | press | MOTION-SPEC §6-2, iOS 26 내비 바 | 눈: 상단 세 요소 사이 월페이퍼가 보임. PW: 각 버튼 ≥ 44×44 |
| 0-6 | (c)(d) | press는 **같은 프레임**에 CSS로(`:active` + `pointerdown` 클래스), React 상태를 거치지 않음 | P0 | press(t90 112) | §5-1 | PW: `pointerdown` 다음 rAF에서 `scale ≠ 1` |
| 0-7 | (e) | 글래스 동시 ≤ 3(상단바·탭 바·컴포저; Island는 불투명). 시트가 열리면 탭 바 글래스는 **불투명 대체**로 | P0 | — | MOTION-SPEC §7 | PW: `[style*=backdrop], .glass` 중 `backdrop-filter≠none`이 화면 안에 ≤ 3 |
| 0-8 | (e) | 감소 모드 쌍둥이: reduced motion = 스프링 → 즉시 또는 `fade`, reduced transparency = 글래스 → 불투명 `--paper-elevated` + 1px 테두리, 고대비 = 테두리 2px | P0 | — | MOTION-SPEC §7 | PW: `emulateMedia({reducedMotion:'reduce'})`로 모든 화면 순회, `getAnimations()`의 duration ≤ 150ms |
| 0-9 | (a) | 첫 방문 editorial(스태거)은 **세션·화면당 1회**만, 30ms×최대 4 | P1 | morph | react-console frequency tiers | PW: 같은 탭 두 번째 방문에서 등장 애니메이션 0 |
| 0-10 | (d) | 탭 데이터는 탭 버튼 `pointerdown`에 프리패치, 이미 본 탭은 캐시 즉시 표시 후 백그라운드 갱신 | P1 | — | §5-2 | PW: 두 번째 방문 탭의 첫 콘텐츠 페인트 ≤ 1프레임 |

---

### 4-1. 실행·온보딩

**현재**: 스플래시 없음, R3F 캐릭터(서브서피스 느낌, **0.2Hz 숨쉬기**, 포인터/자이로 ±6°) + "나만의 모시를 만나보세요" + "시작하기" → 버튼에서 모핑되는 가입 시트(아이디·비밀번호·내 이름·모시 이름) → 로더→체크 → 시트가 상단바 아바타로 수축 → 채팅.

**문제·위험**
- **0.2Hz 숨쉬기 = 5초 주기**. organic-motion은 앰비언트 루프가 **4–6초 대역을 피하거나 진폭 3% 미만**이어야 한다고 본다(전정 민감 대역). 숨쉬기 기준(스케일 ≤ 1.03, 주기 ≥ 2.4s)과도 충돌 가능.
- 가입 4필드는 첫 경험에 무겁다. 실제 앱(REA)은 Google·Kakao·Line·전화번호 로그인(Stytch)이다.
- R3F는 초기 JS 예산(§5-2)을 넘는다. 첫 화면 LCP가 캔버스가 되면 안 된다.

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 1-1 | (a)(e) | 숨쉬기: **주기 3.2s(0.31Hz), 스케일 진폭 ≤ 2%**, 화면 밖·탭 비활성·10초 무입력 후 정지. reduced motion이면 정지 포즈 | P0 | 사인(스프링 아님) | organic-motion §9 앰비언트, §6-9 | PW: 10초 무입력 뒤 rAF 0. 진폭은 캔버스 scale uniform 로그로 ≤ 1.02 |
| 1-2 | (d) | 첫 페인트 = **CSS/SVG 포스터 캐릭터**(정지), R3F는 `requestIdleCallback` 뒤 같은 자리·같은 포즈로 교체(교체 순간 픽셀 차이 최소). LCP 요소는 헤드라인 텍스트 | P0 | fade 240ms | §5-2, 60fps `/` LCP=video poster 1,160ms(실측) | PW: LCP 엔트리 `element.tagName`이 `H1`/`P`, 4G·4× CPU에서 LCP ≤ 1.5s |
| 1-3 | (b) | 가입 시트 1단계 = **소셜 로그인 버튼 3개 + 전화번호**, 2단계 = 내 이름 / 모시 이름(기본값 1개 미리 채움), 비밀번호는 이메일 가입 경로에서만. 시트는 단계마다 높이 모핑 | P0 | morph(시트 높이), 내용 스왑 120/60 | [S1375](https://60fps.design/shots/family-dynamic-sheet-morph-interaction) [S1394](https://60fps.design/shots/family-sequence-of-sheets-vary-in-height-interaction) Family, REA(Stytch) | 눈: 첫 시트에 입력 칸 0–1개. PW: 단계 전환 시 시트 높이 애니메이션이 1회, 페이지 이동 없음 |
| 1-4 | (a)(d) | 서버 확인 → 체크 → 시트가 상단바 아바타로 수축(공유 요소). **완료는 서버 이벤트에만** 묶음 | P0 | morph | [S2137](https://60fps.design/shots/plasma-card-setup-animation) Plasma, MOTION-SPEC §3 Loader→check | PW: 응답을 2s 지연시키면 체크가 2s 뒤에만 그려짐 |
| 1-5 | (b) | 빈 채팅 첫 화면: 캐릭터 정지 + 인사 한 줄 + **연결이 필요 없는 제안 칩 3개** → 탭하면 칩 문구가 컴포저로 이동해 바로 전송 | P0 | morph(칩 → 컴포저), 칩 등장 30ms×3 | [S1710](https://60fps.design/shots/wabi-chat-suggestion-swipe-cards-carousel-interaction) Wabi, [S1972](https://60fps.design/shots/claude-code-empty-state-mascot-illustration-animation) | PW: 칩 탭 후 같은 프레임에 내 말풍선, Island `thinking` ≤ 100ms |
| 1-6 | (e) | 권한(알림·마이크·연결)은 **처음 필요할 때** 스레드 안 카드로. 온보딩에서 묻지 않음 | P0 | — | HIG onboarding "defer permissions" | 눈: 가입 완료까지 OS 권한 팝업 0 |
| 1-7 | (b) | 약관: 필수/선택 구분 목록 + "모두 동의" → 각 행 라벨이 "필수" → 체크 + "동의함"(색만 바꾸지 않음) | P1 | snap | [S1167](https://60fps.design/shots/toss-accept-terms-check-interaction) Toss | 눈: 회색조로 봐도 동의 상태 구분 |
| 1-8 | (a) | 포인터/자이로 추종 ±6° → **±4°, `camera` 스프링**, iOS 자이로 권한은 요청하지 않음(포인터만) | P2 | camera | — | 눈: 손을 떼면 0.6s 안에 정면 복귀 |

---

### 4-2. 채팅(기본 채팅)

**현재**: 상단바(메뉴 원 · 아바타+이름 캡슐 · "초대" 캡슐), 사용자 말풍선 중립, 비서 텍스트는 종이 카드, 브리핑 카드(행동 행), 도구 칩(실행 링 → 체크/오류 → "N단계 수행" 요약 pill), 승인 카드(두 버튼, 기기 키 서명), 자격 증명 카드("기기에서 암호화돼요" → "저장됨 · 7일"), 줄 단위 2px rise 스트리밍, 컴포저 글래스 캡슐(+ · 입력 · 마이크 · 통화 원), 포커스 시 커지며 키보드 위로, 전송 버튼은 마이크에서 모핑.

**문제·위험**
- 실제 앱의 브리핑 카드는 **번호 붙은 긴 글 + 본문 속 질문, 버튼 없음**(REA). 사용자가 답하려면 직접 입력해야 한다.
- 생성 중 **멈추기·경과 시간·단계 이름**이 스펙에 없다(HIG generative-ai 필수).
- 승인 카드가 한 종류(두 버튼)뿐 — 위험도별 차이가 없다(§3-4).
- 하단 크롬 17%(컴포저 + 탭 바).
- 통화 원이 강조색으로 채워져 있다(QA v4-chat).

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 2-1 | (c)(e) | **전송 → 멈추기 모핑**: 생성 중에는 전송 버튼이 정사각형 멈추기로(같은 요소). 멈추면 지금까지의 답을 남기고 "이어서 쓰기" 칩 | P0 | snap | [S1848](https://60fps.design/shots/eimi-generating-card-preview-morph-pop-scale-in-sheet-animation) Stop→Done, [M050](https://60fps.design/motion/superhuman-by-smith-diction), HIG generative-ai | PW: 전송 직후 버튼 `aria-label="멈추기"`, 클릭 시 SSE abort 호출, 부분 답 유지 |
| 2-2 | (b)(d) | **첫 토큰 전 타임라인**: 0–150ms 아무것도 없음 → 150ms 스레드 자리표시 한 줄(정지) → 1s Island 상태 문구 → 2s 경과 시간 | P0 | fade | §5-1, organic-motion §9.1 | PW: 서버 지연 3s 모킹, 100ms 시점 자리표시 없음, 200ms 시점 있음, 2.1s 시점 "2초" 표시 |
| 2-3 | (a) | 자리표시 줄이 **첫 문장으로 모핑**(같은 요소, 높이 `morph`), 점 3개 루프 없음 | P1 | morph | [S0957](https://60fps.design/shots/remy-ai-chat-interaction) Remy(점→말풍선), §6-2 | 눈: 자리표시와 첫 줄 사이 깜빡임 없음 |
| 2-4 | (b)(c) | **브리핑 카드 구조화**: 항목마다 한 행(아이콘 · 제목 한 줄 · 필요하면 동작 버튼 1개), 본문 속 질문은 **빠른 답 칩**(예: "네, 예약해 줘" / "나중에")으로. 긴 설명은 "자세히" 펼침 | P0 | morph(펼침) | [S2042](https://60fps.design/shots/monogram-rich-chat-response-card-swipe-interaction) Monogram 리치 카드, [N014](https://60fps.design/snippets/see-all-menu-expand-interaction), REA 브리핑 카드 | 눈: 브리핑 카드에서 텍스트 입력 없이 첫 행동 가능. PW: 칩 탭 → 내 말풍선 즉시 |
| 2-5 | (b) | 도구 칩: 이름 = 실제 도구("카카오톡 읽는 중"), 완료 후 요약 pill "4단계 · 12초", 펼치면 각 단계의 **입력·결과 요약과 출처** | P0 | snap(칩), morph(펼침) | [S2047](https://60fps.design/shots/monogram-pulse-calendar-connect-reveal-interaction), [S0067](https://60fps.design/shots/arc-search-ai-generation-loader) 출처 목록, [N014](https://60fps.design/snippets/see-all-menu-expand-interaction) | PW: SSE 모킹에서 `tool_call` 이벤트 이름과 칩 문구 매핑 표 일치 |
| 2-6 | (b)(e) | **승인 카드 위험도 3단계**(§3-4): 중간 = 보낼 내용 전문 + 보내기/고치기/취소, 높음 = 금액·대상 요약 + 길게 누르기 1.2s **또는** 같은 자리 2단계 탭 | P0 | snap(확인 확장), linear 1.2s | [N022](https://60fps.design/snippets/delete-to-confirm-button-interaction) [N029](https://60fps.design/snippets/cancel-button-expand-to-confirm-interaction) [N007](https://60fps.design/snippets/hold-to-commit-button-interaction) [S1402](https://60fps.design/shots/family-entering-values-to-confirm-screen-morph-interaction) | PW: 키보드만으로 높음 단계 승인 가능(Tab → Enter → Enter). 눈: 미리보기에 받는 사람·본문 전부 |
| 2-7 | (a)(d) | 승인 후 진행 표시가 **Island로 이동**(사용자는 다른 화면으로 가도 됨), 완료되면 카드가 "보냄 · 오후 3:12" 영수증 pill로 | P1 | morph | [S1391](https://60fps.design/shots/family-contextual-spinner-move-to-sheet-morph-interaction) [S1396](https://60fps.design/shots/family-spinner-move-to-bottom-navigation-on-confirm-transaction) Family, [S2112](https://60fps.design/shots/run-receipt-signature-interaction) | PW: 승인 직후 탭 이동해도 Island `tool` 상태 유지, 완료 시 `done` |
| 2-8 | (c) | **컴포저 휴식 = 작은 pill**(+ · 마이크 · 키보드 아이콘), 탭하면 입력창으로 모핑(키보드와 함께). 키보드 내리면 다시 pill | P1 | `morph`(t90 232) — N012 코드 값 spring(.36,.92)의 t90 201ms와 31ms 차이라 새 역할 불필요 | [S2041](https://60fps.design/shots/monogram-keyboard-icon-morph-to-chat-input-interaction) [N012](https://60fps.design/snippets/keyboard-to-input-morph-interaction) Monogram | PW: 키보드 닫힌 상태 컴포저 높이 ≤ 52px |
| 2-9 | (b) | **하단 크롬 축소(iOS 26 탭 바 최소화)**: 채팅에서 위로 스크롤하거나 입력 중이면 탭 바가 **현재 탭 원 하나로 최소화**되어 왼쪽에 붙고, 컴포저가 같은 줄의 나머지를 차지. 아래로 스크롤하거나 원을 탭하면 탭 바 복귀 | P0 | morph(탭 바 ↔ 원), droplet merge | HIG tab bars(minimize on scroll, accessory), [S2099](https://60fps.design/shots/netflix-poster-reflection-on-bottom-tabs-interaction) | PW: 채팅 스크롤 후 하단 크롬 높이 ≤ 화면의 10%. 눈: 원 ↔ 탭 바가 크로스페이드가 아니라 모핑 |
| 2-10 | (c) | 마이크: **탭 = 받아쓰기 켜기/끄기, 길게 = 누르는 동안 말하기**, 손 떼면 처리 pill. 길게 누르는 동안 뒤는 **불투명 dim**(blur 없음) | P1 | easeInOut .15–.27(코드) ≈ fade/snap | [N024](https://60fps.design/snippets/tap-to-hold-button-pulse-morph-interaction) [S2050](https://60fps.design/shots/monogram-tap-and-hold-mic-liquid-blur-pulse-interaction) [S1945](https://60fps.design/shots/avec-hold-and-speak-interaction) | PW: 300ms 이상 누르면 `listening`, 떼면 `thinking`. 눈: 녹음 중 = 아이콘+문구+레벨 막대 |
| 2-11 | (a) | 본문 속 엔티티(일정·장소·사람·금액)는 칩. 탭하면 칩만 커져 미리보기, 문단은 레이아웃 애니메이션으로 밀림 | P2 | morph | [A093](https://60fps.design/appsites/graphical-header-pill-tap-interaction) Graphical(183ms) | 눈: 문단 리플로가 점프 없이 |
| 2-12 | (d) | 스트리밍: rAF당 1회 커밋, 어절 경계, 마지막 메시지만 재렌더, 지난 메시지 `content-visibility:auto`, 60개 넘으면 가상화 | P0 | fade(줄) | §5-3 | PW: 4× CPU, 2,000토큰 스트림 중 프레임 간격 p95 ≤ 20ms, long task 0 |
| 2-13 | (e) | 자동 스크롤은 바닥 80px 안일 때만, 아니면 "새 메시지 ↓" 캡슐 | P0 | snap | §5-3 | PW: 위로 300px 스크롤 후 스트림 → scrollTop 변화 0, 캡슐 표시 |
| 2-14 | (c) | 메시지 길게 누르기 → 메뉴(복사·다시 생성·고치기·공유)가 말풍선에서 모핑, 나머지는 dim | P1 | spring(.25–.34, .83–.94) ≈ snap | [N030](https://60fps.design/snippets/dropdown-menu-expand-morph-interaction) Circle | PW: 메뉴 rect가 말풍선 rect에서 시작 |
| 2-15 | (a) | "다시 생성": 기존 문단이 줄 단위로 위에서부터 나가고(120ms) 같은 자리에서 새 답 시작 | P2 | fade | [M059](https://60fps.design/motion/elevenlabs-by-thru) ElevenLabs | 눈: 이전 답 버전 "1/2" 전환 가능 |
| 2-16 | (b) | 상단 "초대"는 **사람+ 아이콘 원**(중립), 통화 원도 중립. 강조색은 전송 버튼(입력 있을 때)만 | P0 | — | 0-3 | PW: 채팅 화면 강조색 요소 ≤ 1 |
| 2-17 | (e) | 스크린 리더: 문장 끝마다 polite, 도구 칩 상태 변화 1회, 승인 카드는 `role="group"` + 요약 `aria-describedby` | P0 | — | MOTION-SPEC §7 | PW: `page.accessibility.snapshot()`에 승인 카드 이름·설명 존재 |

---

### 4-3. 드로어

**현재**: 왼쪽에서 `camera`로, 채팅 카드는 .94로 줄며 어두워짐, 가장자리 스와이프 직접 조작, 항목(기본 채팅·친구·둘러보기·보관함·나의 모시), Spotlight 검색, "추가 대화" 스레드(통화·일·친구 아이콘), 보관 토글.

**문제·위험**: 탭 바(둘러보기·보관함·나의 모시)와 드로어 항목이 **중복**이다 — 같은 목적지에 길이 두 개면 사용자가 "어디가 진짜인가"를 헷갈린다. 채팅 카드 .94 축소는 scale < .9 금지 규칙은 지키지만, 텍스트가 든 큰 면적을 스케일하면 흐려진다.

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 3-1 | (b) | 드로어 = **대화 목록 전용**(기본 채팅 고정 + 추가 대화 스레드 + 검색). 탭 바 목적지(둘러보기·보관함·나의 모시)는 드로어에서 제거 | P0 | — | HIG tab bars("don't duplicate navigation") | 눈: 드로어와 탭 바에 같은 목적지 없음 |
| 3-2 | (a)(d) | 채팅 카드 축소 .94 → **.96 + 오른쪽 이동만**, 축소된 카드에는 `will-change` 금지(텍스트 흐림). 끌기 = 손 위치 그대로, 놓으면 속도 반영 `camera` | P1 | camera | MOTION-SPEC §7("never will-change on scaled text") | PW: 드로어 열린 상태에서 채팅 카드 `scale ≥ .96`. 4× CPU 끌기 중 프레임 p95 ≤ 20ms |
| 3-3 | (b) | 스레드 행: 아이콘(통화·일·친구) + 제목 + **마지막 상태**("승인 대기", "완료 · 2시간 전") + 읽지 않음 점. 승인 대기 스레드는 맨 위 고정 | P0 | snap(layout) | §3-0 상태 어휘 | 눈: 승인 대기 스레드가 한눈에 |
| 3-4 | (c) | 검색: Spotlight(초성) + 결과 맨 아래 "모시에게 '…' 물어보기" → 검색바가 컴포저로 모핑 | P1 | morph | [S1476](https://60fps.design/shots/google-ai-mode-search-morph-interaction) Google AI Mode, MOTION-SPEC §3 Spotlight | PW: "ㅋㅋㅇ" 입력 → "카카오 연결" 스레드 매치 |
| 3-5 | (e) | 드로어 `role="dialog"`(모달) + 포커스 트랩 + Esc, 가장자리 스와이프 대안으로 상단 메뉴 원 | P0 | — | MOTION-SPEC §4 | PW: Esc로 닫힘, 포커스가 메뉴 원으로 복귀 |
| 3-6 | (c) | 스레드 행 왼쪽 스와이프 = 보관/삭제(삭제는 행 안 2단계) | P2 | snap | [N022](https://60fps.design/snippets/delete-to-confirm-button-interaction) | PW: 삭제 첫 탭 후 같은 자리 "정말 삭제" 표시 |

---

### 4-4. 둘러보기

**현재**: 큰 제목이 스크롤에 접혀 상단바로, 카테고리 레일(원형 판 + 그림, 선택은 two-edge 드롭렛), "요즘 많이 맡긴 일" 목록(아이콘 판·제목·설명·인원 수·"부탁하기" 캡슐 → press → 로더 → 카드가 새 일 스레드로 공유 요소 모핑), "깽이의 제안".

**문제·위험(QA v2-tab-explore)**: "둘러보기" 바 제목과 "무엇을 맡겨볼까요?" 큰 제목이 **중복**. "부탁하기" 강조 버튼 4개. 칩이 글자만, 설명 없음. "부탁하기"를 누르면 **무엇이 필요한지(연결·권한·시간·한도) 모른 채** 바로 맡겨진다.

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 4-1 | (b) | 제목 하나: 큰 제목 "둘러보기" → 스크롤하면 바 제목으로 인계. "무엇을 맡겨볼까요?"는 검색창 placeholder로 | P0 | 스크롤 연동(스프링 없음) | HIG large titles, MOTION-SPEC §6-4 | 눈: 화면에 같은 의미의 제목 1개 |
| 4-2 | (b)(c) | **카드 → "맡기기 전 확인" 시트**: 카드 탭 → 시트로 모핑 → 무엇을 하는지·필요한 연결(없으면 "연결하기" 행)·예상 시간·무료 한도 소모·예시 결과 → "맡기기"(화면 유일 강조색) | P0 | morph(카드 → 시트 r38), 내용 +60ms | [S2126](https://60fps.design/shots/plasma-duo-style-bottom-sheet-open-interaction) Plasma, [A070](https://60fps.design/appsites/jace-thumbnail-hero-transition) Jace, HIG generative-ai(투명성) | PW: 카드 탭 후 시트 rect가 카드 rect에서 시작(첫 프레임 IoU ≥ .8). 눈: 시트에 필요 연결·시간·한도 |
| 4-3 | (a) | "맡기기" → 시트가 컴포저로 수축하며 문구가 입력되고 즉시 전송, 채팅 탭으로 이동(낙관적 말풍선) | P0 | morph | [S1710](https://60fps.design/shots/wabi-chat-suggestion-swipe-cards-carousel-interaction) Wabi, [S1567](https://60fps.design/shots/queue-ask-ai-chat-random-prompt-interaction) Queue | PW: "맡기기" 클릭 → 같은 프레임 내 말풍선 DOM, Island `thinking` ≤ 100ms |
| 4-4 | (b) | 목록 행 버튼 "부탁하기" 제거 → **행 전체가 버튼**(오른쪽 셰브런). 인원 수는 보조 텍스트 "1.2만 명이 맡겼어요"(tabular) | P0 | press | 0-3, REA | PW: 둘러보기 강조색 요소 ≤ 1(검색 결과 없을 때 0) |
| 4-5 | (b) | 카테고리 칩: 그림 판 + 라벨, 선택은 드롭렛. 첫 칩 "추천". 7개 넘으면 가로 스크롤 + 끝 페이드 마스크 | P1 | lead/trail | REA 카테고리 7종, MOTION-SPEC §6-4 | PW: 화살표 키로 칩 이동 |
| 4-6 | (d) | 카테고리 전환: 목록은 **캐시 즉시** + 백그라운드 갱신. 처음 로드만 150ms 뒤 정지 자리표시(최종 크기) | P0 | fade | §5-1, organic-motion §9.1 | PW: 두 번째 전환 이후 자리표시 0, CLS 0 |
| 4-7 | (c) | 검색: 자연어 입력 → 결과 위에 "모시에게 바로 부탁하기" 행 | P1 | morph | [S1861](https://60fps.design/shots/district-ask-ai-intro-sheet-animation) District Ask AI | PW: 검색어 입력 150ms 디바운스 |
| 4-8 | (b) | "깽이의 제안": 개인화 근거 한 줄("최근 일정이 많아서") + 닫기(×) → 같은 제안 7일 숨김 | P1 | snap(layout 접힘) | HIG generative-ai(왜 추천하는지) | 눈: 제안마다 근거 문구 |
| 4-9 | (e) | 행 VoiceOver 이름 = "제목, 설명, 1.2만 명이 맡김, 버튼" 한 번에 | P1 | — | — | PW: 접근성 스냅샷 이름 확인 |

---

### 4-5. 보관함

**현재**: 세그먼트(아티팩트 | 미디어, two-edge thumb, 콘텐츠 스왑), 아티팩트 카드(문서·대시보드·체크리스트)가 시트로 열림, 대시보드는 차트 규칙, 미디어 그리드 + 업로드 FAB(+)가 피커 시트로 모핑, 빈 상태 문구는 실제 앱("아직 생성한 문서가 없어요 / 깽이하고 함께 필요한 문서나 대시보드를 만들어 보세요.").

**문제·위험(QA v2-tab-archive)**: 세그먼트가 폭의 절반만 차지(HIG: 세그먼트는 내용 폭에 맞추거나 전체 폭). FAB 강조색 + 파란 글로우. 빈 상태에 **행동이 없다**.

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 5-1 | (b) | 세그먼트 **전체 폭**(2개), 상단 고정. 스와이프로도 전환(탭과 동기) | P1 | lead/trail(thumb) | HIG segmented, [S2119](https://60fps.design/shots/revolut-select-plan-tab-scroll-interaction)(탭+스와이프 동기, crossfade는 제외) | 눈: 좌우 여백 = 화면 여백. PW: 스와이프 후 thumb 위치 = 선택 탭 |
| 5-2 | (b) | 빈 상태: 정지 그림 + 실제 문구 + **"{모시 이름}에게 문서 만들어 달라고 하기"** 버튼 → 채팅으로 가며 컴포저에 예시 문구 입력 | P0 | fade(첫 등장) | [S0780](https://60fps.design/shots/family-approvals-empty-state-floating-lock-animation), [S1972](https://60fps.design/shots/claude-code-empty-state-mascot-illustration-animation), §3-10 | PW: 버튼 탭 → 채팅 탭, 컴포저 value가 예시 문구 |
| 5-3 | (c) | FAB 중립(글래스 원) + 글로우 제거. 미디어 탭에서만 보임 | P0 | press | 0-3 | PW: FAB `box-shadow`에 색 있는 blur 없음 |
| 5-4 | (b)(c) | 아티팩트 카드 → **medium 디텐트 시트**(제목·요약·공유·내보내기) → 끌어올리면 large(전체 문서). 아래로 끌어 닫으면 카드 자리로 수축 | P1 | morph(디텐트), camera(놓기) | [S2091](https://60fps.design/shots/recollect-pro-bottom-sheet-to-page-interaction) Recollect, [S1541](https://60fps.design/shots/grok-pull-down-to-go-back-interaction) Grok | PW: 시트 닫기 후 포커스가 원래 카드로 |
| 5-5 | (a)(b) | **생성 중 아티팩트 카드**: 점선 테두리 + 단계 이름 + 멈추기 → 완료되면 같은 카드가 채워지고 버튼이 "열기"로 모핑 | P1 | morph | [S1848](https://60fps.design/shots/eimi-generating-card-preview-morph-pop-scale-in-sheet-animation) Eimi | PW: SSE `artifact_progress` 모킹 시 카드 상태 3단계 |
| 5-6 | (d) | 카드 썸네일은 서버 생성 정지 이미지(지연 로드, `aspect-ratio` 고정), 대시보드 차트는 시트 열릴 때만 렌더 | P1 | — | §5-2 | PW: 보관함 첫 로드 JS ≤ 30KB 추가, CLS 0 |
| 5-7 | (e) | 카드 VoiceOver 이름 = "문서, 제목, 수정 날짜" | P1 | — | — | PW: 접근성 스냅샷 |

---

### 4-6. 나의 모시(프로필)

**현재**: 할당량 카드(막대 `morph`, % 롤), 티켓 행(탭 → 시트: 사용 → 로더→체크 → 막대가 0으로), 7일 사용량 막대 차트 + 툴팁, 프라이버시 카드 → 설명 시트(엔클레이브 측정·암호화 도식), 내 계정, 연결된 앱(아이콘 줄 → 연결), 깽이 섹션(결제 수단·저장된 로그인·정보 공개 범위), 앱 사용(알림·화면 및 디자인). 행 → 상세는 `camera` 수평 + 행 라벨 → 큰 제목 공유 요소.

**문제·위험(QA v4-profile)**: 티켓이 상자 두 개, 연결이 아이콘 줄이 아니라 목록. 실제 앱은 "6% 사용, 오전 4시 초기화"처럼 **언제 다시 쓸 수 있는지**를 말한다.

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 6-1 | (b) | 할당량 카드: "오늘 6% 사용 · 오전 4:00에 초기화" + 막대 + 티켓 수("초기화 티켓 2장") 한 카드에. 티켓은 카드 안 행 | P0 | morph(막대), 오도미터 35ms/자리(값이 바뀌었을 때만) | REA, MOTION-SPEC §3 Counters | 눈: 카드 하나로 "얼마나 남았고 언제 회복되는지" |
| 6-2 | (a)(d) | 티켓 사용: 시트 → 사용 → 로더 → **서버 확인 뒤** 막대가 0으로 `morph`, %가 롤 | P0 | morph | [S2123](https://60fps.design/shots/circle-new-wallet-claim-balance-interaction) Circle(모션블러 제외), MOTION-SPEC §6-6 | PW: 서버 2s 지연 시 막대 변화가 2s 뒤 |
| 6-3 | (b) | 연결된 앱 = **아이콘 줄**(최대 6 + "+3"), 탭 → 연결 화면 | P1 | press | REA(연결된 앱 9개 아이콘 줄) | 눈: 한 줄 |
| 6-4 | (c) | 7일 차트: 손가락 스크럽(즉시) + 툴팁 `snap`, 7일 ↔ 30일 세그먼트 전환은 막대 높이 모핑 | P1 | snap(툴팁), morph(기간) | [N031](https://60fps.design/snippets/graph-scrub-highlight-glow-interaction) [N008](https://60fps.design/snippets/line-graph-morph-interaction) | PW: 막대 `pointermove` 시 툴팁 값 = 데이터 |
| 6-5 | (e) | 차트 숨은 표 + 요약 `aria-label`, 숫자 tabular | P0 | — | §3-14 | PW: `table.sr-only` 행 7개 |
| 6-6 | (b) | 프라이버시 카드 → 설명 시트: 3줄 요약(무엇을 저장·누가 볼 수 있나·지우는 법) 먼저, 도식은 "자세히" | P1 | morph | HIG privacy | 눈: 첫 화면에 3줄 |
| 6-7 | (a) | 행 → 상세: 수평 `camera` + 라벨 → 큰 제목 공유 요소(유지). **뒤로 스와이프는 손 위치 그대로** | P1 | camera | MOTION-SPEC §6-6 | PW: 뒤로 가기 후 스크롤 위치 복원 |

---

### 4-7. 연결

**현재**: 메신저(카카오톡·Slack·Discord·Telegram·LINE·Instagram·Teams…)와 국내 서비스, 연결 시트(기기에서 암호화하는 자격 증명 양식), 카카오톡은 큰 tabular 인증번호 + 카운트다운 링(폰 확인 대기), 상태 pill connecting → connected(체크 그려짐).

**문제·위험**: 연결 직후 **무엇을 할 수 있는지** 안내가 없다. 연결 대기 중 사용자가 화면을 떠나면 상태를 잃는다.

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 7-1 | (b) | 연결 완료 시트: 체크가 그려진 뒤 **"이제 이렇게 부탁해 보세요" 예시 칩 2–3개**(그 서비스 전용) → 탭하면 채팅으로 | P0 | snap(체크), 칩 30ms×3 | [S2017](https://60fps.design/shots/grok-app-connected-pulse-animation) [S1991](https://60fps.design/shots/grok-tool-connected-pulse-animation) Grok(맥동 글로우는 제외) | 눈: 연결 직후 다음 행동 1탭 |
| 7-2 | (a)(d) | 카카오 인증 대기: 큰 인증번호 + 카운트다운 링(1.6s 채움 아닌 **실제 남은 시간**), 화면을 떠나면 Island `tool:"카카오톡 연결 대기"`로 이동 | P0 | linear(남은 시간) | [N002](https://60fps.design/snippets/circle-progress-fill-interaction) [S1391](https://60fps.design/shots/family-contextual-spinner-move-to-sheet-morph-interaction) | PW: 대기 중 탭 이동 → Island 상태 유지, 승인 이벤트 시 `done` |
| 7-3 | (a) | 인증 성공: 숫자 칸이 한 줄로 합쳐지고 체크 | P1 | snap | [S1220](https://60fps.design/shots/toss-otp-successful-animation) [N010](https://60fps.design/snippets/otp-input-pulse-fill-success-interaction) Toss | 눈: 성공 순간 칸 → 결과 모핑 |
| 7-4 | (b) | 목록: "연결됨"(상단) / "연결할 수 있음" 섹션, 연결됨 행에 마지막 동기화 시각 | P1 | — | — | 눈: 상태별 구분 |
| 7-5 | (e) | 연결 시트에 "모시가 할 수 있는 일 / 할 수 없는 일" 2열(권한 범위) | P0 | — | HIG privacy, generative-ai | 눈: 권한 범위 명시 |
| 7-6 | (c) | 연결 해제는 행 안 2단계(`N022`) + "연결된 예약 작업 2개가 멈춰요" 영향 안내 | P1 | snap | [N022](https://60fps.design/snippets/delete-to-confirm-button-interaction) | PW: 첫 탭 후 영향 문구 표시 |

---

### 4-8. 볼트(저장된 로그인 · 결제 수단 · 접근 기록)

**현재**: 저장된 로그인 + 보관 기간 세그먼트(1시간/1일/7일/30일/계속), 만료 카운트다운, 접근 기록 타임라인("이 기기의 키로 확인했어요" 배지), 확인 후 삭제.

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 8-1 | (e) | **앱 전환·`visibilitychange` 시 즉시 가림**(애니메이션 없음), 복귀 시 가린 상태 유지 | P0 | 없음(즉시) | §3-5 | PW: `page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))` 후 값 DOM 비어 있음 |
| 8-2 | (c) | 값 보기 = 눌러서 보기(`N011` 150ms) + 10초 뒤 자동 가림, 복사 시 "30초 뒤 클립보드에서 지워요"(가능한 범위) | P0 | easeInOut .15 | [N011](https://60fps.design/snippets/hide-sensitive-number-interaction) | PW: 10초 뒤 마스크 복귀 |
| 8-3 | (b) | 접근 기록: 시간 · 누가(모시/나) · 무엇에 쓰려고("메일 보내기 승인") · 서명 키 지문 앞 8자 | P0 | — | PACKAGES.md(접근 로그), HIG generative-ai | 눈: 각 기록에 목적 |
| 8-4 | (c) | 삭제: 단일 항목 = 행 안 2단계(`N022`), **전체 삭제 = 체크 2개**("모든 저장 로그인이 지워져요", "연결된 예약 작업이 멈춰요") 체크해야 활성 | P1 | snap | [S1634](https://60fps.design/shots/fuse-delete-wallet-sheet-checkbox-interaction) Fuse | PW: 체크 전 삭제 버튼 `disabled` |
| 8-5 | (c) | 결제 금액 한도 입력: 천 단위 쉼표 이동 | P2 | spring(.22,.88) ≈ snap | [N028](https://60fps.design/snippets/comma-jump-number-input-interaction) Family | 눈: 입력 중 숫자 정렬 유지 |
| 8-6 | (a) | 만료 카운트다운: 1분 이상은 정지("6일 남음"), 마지막 1시간만 분 단위 갱신(초 단위 루프 없음) | P1 | — | 루프 최소화 | PW: 6일 남은 항목 렌더 후 rAF 0 |

---

### 4-9. 친구

**현재**: 친구 목록, 초대 링크 시트(복사·공유), 받은 요청, 친구의 공유 모시 대화(두 에이전트 + 두 사람, 작성자 구분), 차단.

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 9-1 | (b) | 공유 대화 말풍선: 작성자 4종(나 / 내 모시 / 친구 / 친구 모시)을 **아바타 + 이름 + 정렬**로 구분(색만으로 구분 금지) | P0 | — | MOTION-SPEC §7(색만 금지) | 눈: 회색조 스크린샷에서도 4종 구분 |
| 9-2 | (a) | 상대 입력 중: 헤더에 "OO 모시가 답하는 중" pill이 들어와 제목을 밀어냄 | P1 | snap | [S1301](https://60fps.design/shots/honk-typing-pill-slide-interaction) Honk | 눈: 입력 끝나면 제목 복귀 |
| 9-3 | (c) | 초대 시트: 링크 복사 → 버튼 아이콘이 체크로(`N025` 경로 모핑), "복사했어요" 토스트는 Island에서 | P1 | linear .6(아이콘), morph(배너) | [N025](https://60fps.design/snippets/plus-to-tick-button-animation) [N005](https://60fps.design/snippets/forward-toast-icon-animation) | PW: 클립보드 값 = 링크 |
| 9-4 | (e) | 친구 모시에게 내 정보가 어디까지 보이는지 시트 상단 한 줄("일정 제목만 공유돼요") + 정보 공개 범위 설정 링크 | P0 | — | HIG privacy | 눈: 공유 범위 명시 |
| 9-5 | (c) | 차단: 행 안 2단계 + 결과 설명("대화가 숨겨지고 초대가 막혀요") | P1 | snap | [N022](https://60fps.design/snippets/delete-to-confirm-button-interaction), [S2120](https://60fps.design/shots/revolut-create-close-pocket-interaction)(확인 시트는 채택, 분해 효과는 제외) | PW: 첫 탭 후 결과 설명 |

---

### 4-10. 통화

**현재**: 컴포저 통화 원 → Dynamic Island → 통화 카드(음량에 반응하는 아바타, 타이머, 음소거, 스피커, 종료), STT → 에이전트(음성 모드) → TTS, 자막 줄이 올라옴.

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 10-1 | (a) | **연결 중 vs 연결됨을 모양으로**: 연결 중 = 활동 링, 연결됨 = 링이 원으로 닫히고 타이머 시작 | P0 | snap | [S0052](https://60fps.design/shots/chatgpt-listening) ChatGPT(그라디언트 제외), [S1289](https://60fps.design/shots/honk-call-connect-pulse-animation) Honk | PW: 연결 이벤트 전 타이머 미표시 |
| 10-2 | (a) | 캐릭터·레벨 막대 = **실제 음량**(AnalyserNode 30Hz, 0.1s 평활). 무음이면 정지 | P0 | — | [M019](https://60fps.design/motion/work-with-island-by-bruno), §3-6 | PW: 오디오 입력 무음 모킹 시 막대 높이 0 |
| 10-3 | (a) | 종료: 카드 → Island ≤ 300ms | P1 | morph(t99 329) | [S2039](https://60fps.design/shots/chatgpt-voice-blob-gradient-interaction) ChatGPT(300ms) | PW: 종료 클릭 후 330ms 안에 카드 DOM 제거 |
| 10-4 | (e) | 자막 항상 켬, 지금 말하는 문장만 굵게, 지난 문장은 보조색 | P0 | fade | [S1640](https://60fps.design/shots/perplexity-conversation-word-sentence-audio-interaction) Perplexity | 눈: 굵기 + 색 둘 다 |
| 10-5 | (c) | 음소거·스피커·종료 64px 이상, 종료만 빨강(유일 강조) | P0 | press | HIG | PW: 버튼 크기 |
| 10-6 | (d) | 마이크 권한은 통화 원 첫 탭에서만 요청, 거부되면 Island `error` + "설정에서 마이크 허용" | P0 | — | HIG onboarding | PW: 권한 거부 모킹 시 안내 표시 |
| 10-7 | (b) | 통화 중 다른 화면 이동 가능, Island가 미니 컨트롤(타이머·음소거·종료) | P1 | morph | [N013](https://60fps.design/snippets/mini-player-play-and-scrub-interaction) 미니 플레이어, MOTION-SPEC §5 | PW: 탭 이동 후 Island `call` 유지 |

---

### 4-11. 예약된 일

**현재**: 반복 작업 목록(모닝콜·출석체크·브리핑) + 토글(Focus식 렌즈 노브).

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 11-1 | (b) | 행 = 이름 + **다음 실행 시각**("내일 오전 7:00") + 반복 요일 + 마지막 결과("어제 완료") + 토글 | P0 | — | HIG lists | 눈: 행에 다음 실행 시각 |
| 11-2 | (c) | 토글: Focus식 렌즈(유지), **목록 행에만**. 끄면 "다음 실행 없음"으로 문구 스왑 | P1 | snap(트랙), 렌즈 1.35 | MOTION-SPEC §3 Toggle | PW: `role="switch"`, `aria-checked` 변화 |
| 11-3 | (c) | 반복 요일 편집: ± 스테퍼 + 요일 pill 동시 갱신 | P2 | snap, 오도미터 | [S2135](https://60fps.design/shots/runmo-days-counter-interaction) Runmo | 눈: 숫자와 요일 동기 |
| 11-4 | (c) | "지금 실행" 버튼(즉시 1회) + 반복 전체 중단은 길게 누르기 대신 2단계 | P1 | snap | [S0558](https://60fps.design/shots/focuspomo-hold-to-stop-interaction)(길게 대신 2단계 선택), [N029](https://60fps.design/snippets/cancel-button-expand-to-confirm-interaction) | PW: 2단계 확인 후에만 중단 API 호출 |
| 11-5 | (b) | 빈 상태: "매일 아침 브리핑 받아 보기" 등 템플릿 3개 | P1 | fade | §3-10 | PW: 템플릿 탭 → 생성 시트 |
| 11-6 | (e) | 실행 결과 알림은 HIG 중단 수준 time-sensitive(모닝콜)·passive(출석체크) 구분 | P1 | — | HIG notifications | 눈: 설정에 수준 표시 |

---

### 4-12. 설정(알림 / 정보 공개 범위 / 화면 및 디자인)

**현재**: 토글, 테마 세그먼트(시스템/라이트/다크, View Transition 200ms 루트 크로스페이드 — 유일하게 허용된 크로스페이드), 동작 줄이기·투명도 줄이기 재정의, 글자 크기 슬라이더(러버밴드).

| # | 영역 | 개선 | P | 역할 / 타이밍 | 근거 | 수용 검사 |
|---|---|---|---|---|---|---|
| 12-1 | (b) | **기본값은 전부 "시스템 따름"**(테마·동작 줄이기·투명도·글자 크기). 앱 재정의는 "시스템과 다르게" 섹션 아래 | P0 | — | HIG settings("don't duplicate OS settings") | PW: 첫 실행 `prefers-color-scheme: dark`에서 다크, 앱 설정값 `system` |
| 12-2 | (a) | 테마 전환 200ms 루트 크로스페이드 유지. **원형 와이프 금지**, reduced motion이면 즉시 | P1 | 200ms linear | react-console("never circular theme wipes") | PW: reduced motion에서 View Transition 미사용 |
| 12-3 | (c) | 글자 크기 슬라이더: 단계 스냅 7단 + 미리보기 문장(채팅 말풍선 모양)이 실시간 변화 | P1 | snap(스냅), 러버밴드 d=60 | MOTION-SPEC §3 Slider | PW: 화살표 키로 단계 이동 |
| 12-4 | (b) | 알림: 종류별(승인 요청·완료·예약된 일·친구) 토글 + 중단 수준 설명 한 줄 | P1 | — | HIG notifications | 눈: 종류별 설명 |
| 12-5 | (b) | 정보 공개 범위: 친구 모시에게 보이는 항목 목록(일정 제목·위치·연락처…) + 예시 미리보기("친구 모시는 이렇게 봐요") | P1 | morph(미리보기 갱신) | HIG privacy | 눈: 바꾸면 미리보기 즉시 갱신 |
| 12-6 | (e) | 설정 화면 자체는 모션 최소: 행 press 배경만, 토글 `snap` | P0 | press, snap | react-console frequency tiers | PW: 설정 화면 진입 시 등장 애니메이션 0 |

## 5. 반응 속도 예산

> 기준 기기: **중급 안드로이드(갤럭시 A5x급) + 4× CPU 스로틀, 4G(150ms RTT, 1.6Mbps)** 와 **iPhone 13 이상 WebKit**. Playwright로 Chromium·WebKit 둘 다 측정. "체감"은 사람이 보는 것, "실제"는 데이터가 오는 것.

### 5-1. 입력 → 피드백

| 항목 | 목표 | 측정 방법(Playwright) | 근거 |
|---|---|---|---|
| 입력 → 첫 시각 피드백 | **같은 프레임**(≤16.7ms, 120Hz면 ≤8.3ms). press 상태는 CSS `:active`/`pointerdown` 클래스로, React state를 거치지 않는다 | `pointerdown` 후 다음 rAF에서 `getComputedStyle(el).scale`이 1이 아님 | organic-motion §3-2 "press paints first", 60fps hover 150–200ms(실측 10-05) |
| INP(p75) | ≤ **100ms**(Good 200ms의 절반) | `PerformanceObserver({type:'event', durationThreshold:16})` 최대값 | |
| 탭 전환 → 새 내용이 보이기 시작 | ≤ **1프레임** 후 시작, 180ms에 읽힘 | 탭 클릭 시각 대비 새 화면 h1의 opacity > 0 시각 | Aave A051 ≈180ms(추정), react-console "route change without waiting" |
| 시트·카드→상세 열림 | 체감 ≈230ms(t90), 안착 ≤ 630ms. **열리는 동안에도 입력 가능** | 시트 rect의 t90 시각, 열리는 중 두 번째 탭이 무시되지 않는지 | morph .45/.86 t90 232ms, S2126 카드→시트 567–933ms(추정) |
| 메시지 전송 → 내 말풍선 | **같은 프레임**(낙관적), 실패 시 말풍선에 "다시 보내기" | 전송 버튼 `pointerup`과 말풍선 DOM 삽입 간격 | 되돌릴 수 있는 것만 낙관적으로(§3-1) |
| 전송 → 에이전트 존재 표시(Island "생각 중") | ≤ **100ms** | Island `data-state` 변경 시각 | S2043 하단 pill → thinking(추정 700ms 중 첫 반응은 즉시) |
| 전송 → 첫 토큰(TTFT, 서버) | p50 ≤ 800ms, p95 ≤ 2s | SSE 첫 `text` 이벤트 시각 | |
| 첫 토큰 전까지 | 0–150ms 아무것도 안 그림 → 150ms에 스레드 안 자리표시 한 줄(정지, shimmer 없음) → 1s에 구체적 상태 문구("일정 확인하는 중") → 2s 넘으면 단계 목록 + 경과 시간 + 멈추기 | 각 시점 스냅샷 | HIG generative-ai "specific feedback", organic-motion §9.1 |
| 도구 단계 하나 | 시작 즉시 칩 표시(활동 링), 완료는 **서버 이벤트로만** 체크 | SSE `tool_result` 이후에만 check path가 그려지는지 | |
| 실패 판정 | 15s 무응답이면 원인 + 다시 시도, 입력 보존 | 네트워크 차단 테스트 | organic-motion §9.1 |

### 5-2. 첫 실행·재실행(PWA)

| 항목 | 목표 | 메모 |
|---|---|---|
| HTML + 인라인 크리티컬 CSS | ≤ 14KB gz(첫 RTT 안) | 배경 CSS 포스터(월페이퍼 그라디언트) 포함 → 첫 프레임이 최종 레이아웃 |
| 초기 JS(첫 화면) | ≤ **170KB gz** | React 19 + framer-motion 코어 + 채팅 화면. 60fps.design 806KB의 ≈1/5 |
| 지연 청크 | R3F/three(≈150–290KB gz)는 `requestIdleCallback` 뒤, reduced motion·Save-Data·`deviceMemory<4`·소프트웨어 GL이면 **아예 안 받음** | 온보딩 캐릭터·월페이퍼 셰이더 |
| FCP / LCP | 콜드 4G: FCP ≤ 1.0s, LCP ≤ 1.5s(p75 ≤ 2.5s). **재실행(서비스 워커 앱 셸)**: FCP ≤ 300ms | LCP 요소는 글자(브리핑 카드 제목)여야 함, 이미지·캔버스 아님 |
| CLS | 0 목표(≤ 0.02) | 자리표시는 최종 크기로 |
| TBT(첫 로드) | ≤ 200ms, 50ms 넘는 long task 0개(상호작용 중) | 60fps.design 콜드 long task 179·228ms(실측)은 반면교사 |
| SDUI 정의 | `stale-while-revalidate` 캐시, 첫 화면은 캐시본으로 즉시 | REA: 서버 주도 UI(`/api/ui-definitions`) |
| 프리패치 | 유휴 시 둘러보기 목록·보관함 목록·할당량. `pointerdown`에 상세 데이터 | 같은 GET은 한 Promise로 공유(react-console §3) |

### 5-3. 스트리밍 렌더 주기

- 토큰은 버퍼에 쌓고 **rAF당 한 번만 커밋**(저사양 tier는 30Hz). 마지막 메시지 컴포넌트만 다시 렌더하고, 지난 메시지는 `memo` + `content-visibility: auto`.
- 한국어는 **어절(공백) 경계에서만** 화면 텍스트를 늘린다. 줄이 넘어가는 순간 그 줄 전체에 2px rise(MOTION-SPEC §6-2). 글자 단위 타자기 금지.
- 마크다운은 증분 파싱(완결된 블록만 확정, 열린 블록은 평문 미리보기). 표·코드 블록은 닫힐 때 한 번에 레이아웃.
- 자동 스크롤은 **사용자가 바닥에서 80px 안에 있을 때만**. 위로 읽고 있으면 고정하고 "새 메시지 ↓" 캡슐을 띄운다.
- 스크린 리더: `aria-live="polite"`는 **문장이 끝날 때마다** 한 번(MOTION-SPEC §7 유지).
- 예산: 스트리밍 중 메인 스레드 작업 프레임당 ≤ 8ms, 스트리밍 중 스크롤 프레임 > 20ms 비율 ≤ 1%.

### 5-4. 프레임 예산(글래스·WebGL)

| 항목 | 예산 |
|---|---|
| 동시 `backdrop-filter` | ≤ 3개(MOTION-SPEC §7 유지), blur 반경은 **애니메이션하지 않는다**(투명도만) |
| 전체 화면 크기 요소의 `filter: blur()` 애니메이션 | **금지**(현재 탭 전환이 이것 — §4-공통 참고). 블러 전환은 뷰포트 25% 이하 컨테이너만 |
| 월페이퍼 셰이더 | GPU ≤ 2ms/프레임(중급폰), DPR `clamp(dpr*.6,.75,1.25)`, **변화가 없으면 렌더하지 않음**(스프링·패럴랙스가 움직일 때만 rAF), 30프레임 중앙값 > 28ms면 정지 |
| liquid-glass-js 렌즈 | 스프링이 멈춘 뒤에만 재캡처(MOTION-SPEC §1 유지), 캡처 1회 ≤ 30ms |
| 전환 중 프레임 드롭 | 4× 스로틀에서 프레임 간격 p95 ≤ 20ms, 드롭 ≤ 1% |
| 메모리 | 메시지 200개 후 JS 힙 ≤ 60MB, 60개 넘으면 가상화 |

### 5-5. 검증 스크립트(공통)

```ts
// qa/perf.spec.ts 개요 — Chromium(4× CPU, 4G)과 WebKit에서 같은 시나리오
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.addInitScript(() => {
  const iv: number[] = []; let last = performance.now();
  const tick = (t: number) => { iv.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick); (window as any).__frames = iv;               // 프레임 간격
  new PerformanceObserver(l => l.getEntries().forEach(e => ((window as any).__inp ??= []).push(e.duration)))
    .observe({ type: 'event', durationThreshold: 16, buffered: true } as any);   // INP 후보
  new PerformanceObserver(l => l.getEntries().forEach(e => ((window as any).__lt ??= []).push(e.duration)))
    .observe({ type: 'longtask', buffered: true });
});
// 판정: p95(frames) ≤ 20, max(inp) ≤ 100, 상호작용 구간 longtask 0
```

## 6. 금지·주의 목록 — 60fps에서 본 것 중 우리가 하지 않을 것

> 60fps의 AI·어시스턴트 샷은 **"AI다움 = 무지개 그라디언트 글로우"** 로 수렴해 있다(아래 1번에 7건). 우리 브리프(글로우·바운스·크로스페이드·글래스 위 글래스 금지)와 정면으로 부딪친다. 우리 쪽 "AI가 일하고 있음"의 신호는 **Dynamic Island 상태 + 구체적인 상태 문구**다.

| # | 패턴 | 60fps에서 본 사례 | 왜 안 되나 | 우리 대안 |
|---|---|---|---|---|
| 1 | **그라디언트 글로우·테두리 트레이스로 "AI 활성" 표시** | S1973 Gemini 입력창 그라디언트 맥동, S1954 Gemini 응답 배경 색 변화, S1565 Perplexity 음성 모드 흐르는 테두리, S1548 Perplexity 금색 테두리, S1485 Google Lens 테두리 맥동, S2108 Uber 검색창 테두리 트레이스, N026 버튼 테두리 스트로크(Revolut) | 브리프 금지(글로우·네온). 정보가 없는 큰 면적의 지속 움직임. 대비가 떨어지고 배터리를 쓴다 | Island가 늘어나며 "일정 확인하는 중" 같은 문구(콘텐츠 스왑), 컴포저 전송 버튼이 "멈추기"로 모핑 |
| 2 | **상태 문구 무한 순환**(정보 없는 카피 루프) | S1922 Swiggy 요리 문구 순환, S2103 Uber 로딩 문구 교차, A095 Safari 헤드라인 순환(417–1117ms, 추정) | 실제 진행과 무관 → 신뢰 하락(HIG progress "honest") | 서버가 보낸 **실제 단계 이름**만 바꾼다. 단계가 안 바뀌면 문구도 그대로, 대신 경과 시간 |
| 3 | **스플래시·로고 애니메이션 화면** | S2113 Threads, S2127 Runmo, S2132 Whatnot, S2136 DOOD, S2131 Circle, S2111 Revolut 영상 | HIG launching "no splash", 첫 화면 지연 | 첫 페인트 = 최종 레이아웃(MOTION-SPEC §6-1 유지) |
| 4 | **파티클·컨페티·분해 효과** | S2110 X 좋아요 봇 머리 폭발, S2124/S2114 Duolingo 스파클·컨페티, S2116/S2120 Revolut 포켓 삭제 시 입자 분해, N021 카드 불태우기, N007 완료 시 입자 | 브리프 금지. 삭제가 "축하"처럼 보임. 저사양에서 프레임 드롭 | 체크가 그려지는 것(stroke draw)과 문구 하나. 삭제는 행이 접히고 실행 취소 토스트 |
| 5 | **탄성 바운스(오버슈트 > 3%)** | N023 무료 체험 스위치 `spring(.27,.72)` = 3.7%(계산), S2097 Revolut 숫자 세그먼트 "bouncy", S1848 Eimi 카드 팝 "pronounced springy bounce", S2131 Circle 아바타 팝 | 브리프 상한 3% | 모든 역할 ≤ 3%(MOTION-SPEC §2), 60fps 스니펫 다수도 ζ .88–.94(§2-3) |
| 6 | **상태 사이 크로스페이드** | A093 Graphical pill 텍스트 crossfade, S2119 Revolut 요금제 crossfade + 배경 그라디언트 변색, S2134 Runmo 지표 crossfade, S2053 ChatGPT 슬라이더 라벨 crossfade | 브리프 "morph, never crossfade" | 같은 요소 모핑 + 콘텐츠 스왑(나감 120ms → 60ms 뒤 들어옴, 겹치지 않음) |
| 7 | **배경색·테마색 전체 변색으로 상태 표시** | S2119, S1452 Perplexity 요금제 탭(금↔청록 전체 변색), S2100 X 팀 색 배경 | 강조색은 하나(MOTION-SPEC §0), 색만으로 상태 표시 금지 | 강조색은 선택/주 버튼에만. 상태는 아이콘+문구 |
| 8 | **shimmer 스윕 스켈레톤·카드 광택** | S2115 Revolut 카드 sheen 4.6s 루프, N011 가린 숫자 위 shimmer | 가장 넓은 면적에 정보 없는 움직임(organic-motion §9.1) | 정지된 자리표시(150ms 뒤에만), 가린 값은 정지 점 |
| 9 | **궤도·회전 아이콘 상시 루프** | S1990/S1952 Grok 연결 시트 로고 궤도, S1948 Meta AI 꽃잎 루프, S1883 Smallcase 별 숨쉬기, S2080 Grok 마스코트 표정 루프 | 뷰포트당 앰비언트 루프 1개 이하, 보이지 않으면 멈춤(HIG) | 루프는 온보딩 캐릭터 하나, 진폭 ≤ 2%, 주기 4–6초 대역 회피(§4-1) |
| 10 | **자동 재생 가치 제안 캐러셀** | S2129 Runmo, S2064 ChatGPT Plus 3단계, S2082 Reve, S2107 CRED | HIG onboarding "teach by doing", 읽기 속도를 빼앗음 | 실제 일을 한 번 맡겨 보게 하는 칩(§4-1) |
| 11 | **배경 전체 블러 오버레이 위 컨트롤** | S2050 Monogram 길게 누르기 시 콘텐츠 전체 점진 블러 | 큰 면적 blur 애니메이션 비용, 우리 기준 "글래스 위 글래스" 위험 | 길게 누를 때는 컴포저만 커지고 뒤는 **불투명 dim**(blur 없음) |
| 12 | **코치마크 연속 투어** | S2118/S2117 Revolut 테두리 맥동 코치마크 | 투어는 건너뛰기 어렵고 다시 못 찾음 | 처음 쓸 때 그 자리에 한 문장 팁, 닫으면 다시 안 나옴 |
| 13 | **길게 누르기 2초 고정** | N007 Hold to Commit `linear(duration: 2.0)` | 자주 쓰는 승인에 2초는 길고, 손 떨림·보조기기 사용자에게 불리 | 고위험(결제·외부 발송)만 1.2s, 대안 버튼 항상 제공(§3-4) |
| 14 | **WebGL 굴절 스크롤 왜곡** | A082 System, A079 Shader | 비용 최고, 제품 UI에 정보 없음 | 셰이더 렌즈는 우리가 그리는 월페이퍼에만(MOTION-SPEC §1) |
| 15 | **스크롤 연동 3D 마케팅 연출** | 신규 A094/A096 Apple HomeView, A095 Safari 3D 로고 | 앱 화면에는 맞지 않음(HIG: 제품 UI는 스크롤에 연출을 묶지 않음) | 큰 제목 → 바 제목 인계와 스크롤 엣지 효과만 |

### 6-1. 우리 브리프와의 충돌 정리

- **바운시 이징**: 60fps 스니펫의 다수는 ζ .82–.94(오버슈트 ≤ 1.1%)라 우리와 같은 편이다. 예외 N023(3.7%)·S2097만 피한다.
- **크로스페이드**: 60fps 설명문에 "crossfade"가 흔하게 나오지만, 실제로는 같은 자리에서 텍스트만 바뀌는 경우가 많다. 우리는 **텍스트 스왑을 순차(나감→들어옴)** 로 만들고, 두 요소를 겹치는 진짜 크로스페이드는 테마 전환 하나만 허용한다(MOTION-SPEC §6-12 유지).
- **글로우**: 1번 표 전체. Grok 연결 완료(S2017/S1991)의 "빛 맥동"은 **체크가 그려지는 것으로 바꾼다**.
- **글래스 위 글래스**: 60fps에서 이 문제를 일으키는 건 대개 "블러 시트 위 블러 카드"와 "블러 배경 위 글래스 버튼"(S1564 Perplexity 모드 시트는 배경 블러 + 시트). 우리 시트는 **불투명 종이 + 글래스 테두리만**(apple-hig SKILL §2.1: "Form sheets over arbitrary content: opaque").

## 7. 구현 체크리스트(P0 / P1 / P2)

> 경로는 `apps/mobile/src/` 기준. "있음"은 11-11 스냅샷에 파일이 있다는 뜻이고, "새로"는 아직 없다는 뜻이다(재작성 중이라 이름은 브리프의 컴포넌트 이름을 따랐다). 각 항목 끝 괄호는 §4 항목 번호.

### P0 — 신뢰·체감 속도에 직접 영향

- [ ] **`motion/ContentSwap.tsx`(있음)** — 페이지 크기 콘텐츠에는 블러·나감 애니메이션을 쓰지 않는다. `direction` 모드를 "이전 페이지 즉시 제거 + 새 페이지 opacity 180ms linear + y 6px `camera`"로 바꾸고, 블러 스왑은 컨테이너 면적 ≤ 25% 뷰포트일 때만 허용하는 가드(개발 모드 경고)를 넣는다. (0-1)
- [ ] **`TabBar`(새로, `ui/TabBar.tsx`)** — two-edge 드롭렛, 라벨 색은 선행 가장자리 도달 시. 채팅 탭에서 **스크롤·입력 시 최소화**(현재 탭 원 하나) + 컴포저가 같은 줄로. 시트가 열리면 불투명 대체. (0-2, 0-7, 2-9)
- [ ] **`app/island.ts`(있음) + `DynamicIsland`(새로, `ui/DynamicIsland.tsx`)** — 모드 확장: `idle | listening | thinking | tool | streaming | awaiting_approval | done | error | offline | call`. idle은 정지(파형·점 맥동 제거). 레벨 막대는 실제 값만. 2초 넘으면 경과 시간. `role="status"` + 탭 이동 `<button>`. (0-4, §3-0)
- [ ] **`api/sse.ts`·`api/events.ts`(있음)** — 도구 이름 → 상태 문구 매핑 표(`tool.name → "OO하는 중"`), `approval_required`·`artifact_progress` 이벤트를 Island·스레드에 같은 상태로 전달. abort 지원(멈추기). (2-1, 2-5)
- [ ] **`Composer`(새로, `ui/Composer.tsx`)** — 전송 ↔ 멈추기 모핑(같은 요소), 첫 토큰 전 타임라인(0/150ms/1s/2s), 낙관적 말풍선 같은 프레임, 실패 시 "다시 보내기" + 입력 보존. (2-1, 2-2)
- [ ] **`ApprovalCard`(새로, `ui/ApprovalCard.tsx`)** — 위험도 3단계(낮음: 실행 취소 배너 / 중간: 전문 미리보기 + 보내기·고치기·취소 / 높음: 길게 누르기 1.2s **와** 같은 자리 2단계 탭 동시 제공), 서명 → 로더 → 서버 확인 → 영수증 pill. (2-6, §3-4)
- [ ] **`ToolChip`(새로, `ui/ToolChip.tsx`; 기존 `ui/Chip.tsx` 확장 가능)** — 실행 중 링(SVG dashoffset 1개) → 체크(서버 이벤트 후) / 오류, 완료 후 "N단계 · 12초" 요약 pill, 펼치면 단계별 입력·결과·출처. (2-5, §3-2)
- [ ] **`BriefingCard`(새로)** — 항목 행 구조 + 본문 질문을 빠른 답 칩으로. (2-4)
- [ ] **`StreamText`(새로, 채팅 메시지 렌더러)** — rAF당 1회 커밋, 어절 경계, 줄 단위 2px rise(`fade`), 증분 마크다운, 문장 끝 polite, 바닥 80px 규칙 + "새 메시지 ↓". (2-12, 2-13, §5-3)
- [ ] **`Sheet`(새로, `ui/Sheet.tsx`)** — 출처 rect에서 모핑(clip-path → r38), 내용 +60ms, 디텐트(medium/large), 단계별 높이 모핑, **불투명 종이 배경**, 요청 진행 중 닫기 거부, 포커스 트랩/복귀. 둘러보기 "맡기기 전 확인" 시트가 첫 사용처. (4-2, 1-3)
- [ ] **`Glass.tsx`(있음)** — 화면당 ≤ 3 카운터(개발 모드 경고), reduced transparency → 불투명 `--paper-elevated` + 1px 테두리. (0-7, 0-8)
- [ ] **`usePress.ts`(있음)** — press를 CSS 클래스로 같은 프레임에(상태 경유 금지). 불투명 버튼은 2px 내림 + 6% 어둡게(`N027` 근거, 축소 없음). (0-6)
- [ ] **강조색 감사** — `styles/tokens.css`(있음)에 `--accent` 사용처를 화면당 1곳으로. "초대"·"부탁하기"·통화·FAB 중립화, FAB 글로우 제거. (0-3, 2-16, 4-4, 5-3)
- [ ] **`AgentBlob.tsx`·`AgentBlobLazy.tsx`(있음)** — 숨쉬기 3.2s 주기·진폭 ≤ 2%, 10초 무입력·화면 밖 정지, CSS/SVG 포스터 먼저 → 유휴 시 R3F 교체. (1-1, 1-2)
- [ ] **가입 흐름** — 1단계 소셜 3 + 전화번호, 2단계 이름/모시 이름, 서버 확인 후 아바타로 수축, 권한은 나중에. (1-3, 1-4, 1-6)
- [ ] **빈 채팅·빈 보관함 — `EmptyState.tsx`(있음)** — 정지 그림 + 한 문장 + 실제 행동 버튼(컴포저 예시 문구 입력). 제안 칩 → 컴포저 공유 요소. (1-5, 5-2)
- [ ] **`Drawer`(새로)** — 대화 목록 전용(탭 바 목적지 제거), 스레드 상태 행, 승인 대기 고정, 모달 포커스 트랩. (3-1, 3-3, 3-5)
- [ ] **`LargeTitle`(새로)** — 둘러보기 제목 1개, 스크롤 인계. (4-1)
- [ ] **볼트 보안** — `visibilitychange` 즉시 가림, 10초 자동 가림, 접근 기록에 목적·키 지문. (8-1, 8-2, 8-3)
- [ ] **통화** — 연결 중/연결됨 모양 구분, 실제 음량, 자막 항상, 종료만 빨강. (10-1, 10-2, 10-4, 10-5, 10-6)
- [ ] **설정 기본값 "시스템 따름"** (12-1)
- [ ] **`qa/perf.spec.ts`(새로)** — §5-5 스크립트: 4× CPU·4G에서 프레임 p95 ≤ 20ms, INP ≤ 100ms, 상호작용 중 long task 0, idle 3초 뒤 running animation 0, reduced motion 순회. (§5)

### P1 — 완성도

- [ ] **`SegmentedControl`(새로)** — 전체 폭, two-edge thumb, 스와이프 동기, ≤ 5개. (5-1)
- [ ] **`Toggle.tsx`(있음)** — 목록 행 전용 사용 감사, 끄면 보조 문구 스왑. (11-2)
- [ ] **`Slider.tsx`(있음)** — 글자 크기 7단 스냅 + 미리보기 말풍선, 화살표 키. (12-3)
- [ ] **`BarChart.tsx`(있음)** — 스크럽(즉시) + 툴팁 `snap`, 기간 전환 높이 모핑, 숨은 표. (6-4, 6-5)
- [ ] **`Odometer.tsx`(있음)** — 값이 바뀐 경우만 롤, 모션블러 없음. (6-1, 6-2)
- [ ] **`Spotlight.tsx`(있음)** — 결과 맨 아래 "모시에게 물어보기" → 검색바가 컴포저로 모핑. (3-4)
- [ ] **`Banner`(새로, Island에서 늘어남)** — 동시 1개 + 대기열, 문구 길이 기반 유지, 오류는 점으로 줄어 사라짐, 실행 취소 5초. (§3-11, [S1484](https://60fps.design/shots/cobot-toast-expand-shrink-interaction))
- [ ] **`CredentialCard`(새로)** — 불투명 시트, 보관 기간 세그먼트, 저장 후 pill 수축. (§3-5)
- [ ] **컴포저 휴식 pill ↔ 입력창 모핑**, 마이크 탭/길게 구분, 길게 누를 때 불투명 dim. (2-8, 2-10)
- [ ] **메시지 길게 누르기 메뉴**(말풍선에서 모핑). (2-14)
- [ ] **승인 후 진행 → Island 이동**, 영수증 pill. (2-7)
- [ ] **둘러보기 카테고리·검색·제안 근거.** (4-5, 4-7, 4-8)
- [ ] **보관함 디텐트 시트·생성 중 카드.** (5-4, 5-5)
- [ ] **연결 완료 예시 칩, 대기 Island 이동, 권한 범위 2열.** (7-1, 7-2, 7-5)
- [ ] **친구 공유 대화 작성자 4종, 입력 중 pill, 공개 범위 한 줄.** (9-1, 9-2, 9-4)
- [ ] **예약된 일 행 정보(다음 실행·마지막 결과).** (11-1, 11-4)
- [ ] **`AdaptivePointer`(새로)** — 태블릿·데스크톱 fine pointer만, `(pointer: coarse)`에서 숨김. MOTION-SPEC §4 그대로.

### P2 — 여유 있을 때

- [ ] 본문 엔티티 칩(문단 리플로 모핑). (2-11)
- [ ] "다시 생성" 줄 단위 교체 + 버전 전환. (2-15)
- [ ] 드로어 스레드 스와이프 동작. (3-6)
- [ ] 결제 한도 쉼표 이동 입력. (8-5)
- [ ] 반복 요일 스테퍼. (11-3)
- [ ] 캐릭터 포인터 추종 ±4°. (1-8)

### 7-1. MOTION-SPEC.md에 반영할 변경(제안)

| 절 | 현재 문구 | 바꿀 내용 | 이유 |
|---|---|---|---|
| §6 머리말 | "Screen-to-screen = the tab droplet moves … while the content swaps (exit 120 → enter +60 …)" | "Screen-to-screen = droplet moves (two-edge); **the old page is removed at once (no exit, no blur); the new page enters opacity 180ms linear + y 6px on `camera`.** Blur content swaps only inside containers ≤25% of the viewport." | v3-midswitch 빈 프레임, 전체 화면 blur 비용, react-console 레시피 |
| §6-1 | "idle breathing at 0.2Hz" | "idle breathing period 3.2s (≈0.31Hz), scale amplitude ≤2%, stops when offscreen / hidden / 10s without input; still pose on reduced motion" | 0.2Hz(5s)는 앰비언트 루프 회피 대역(4–6s) 안 |
| §6-1 | "Sign-up … handle, password, my name, Pickle name" | "Step 1: Google / Kakao / LINE / phone (Stytch), password only on the email path; step 2: my name + Pickle name (default suggested). Permissions are asked when first needed, never during sign-up." | 실제 앱 인증 방식, HIG onboarding |
| §5 | 모드 5개(idle·thinking/working·tool done·call·notification) | §3-0 상태 어휘 10개, **idle은 정지**, 레벨 막대는 실제 값(음량/토큰 속도)만, 2초 넘으면 경과 시간 | 가짜 활동 제거, HIG generative-ai |
| §6-2 | "approval cards (two buttons, approve = primary …)" | 위험도 3단계(§3-4) + 높음 단계는 길게 누르기 1.2s **와** 같은 자리 2단계 탭을 함께 | 접근성(스위치 제어·VoiceOver), N022/N007 |
| §6-2 | (없음) | "While generating, the send button morphs into **Stop**; first-token timeline 0/150ms/1s/2s; tool chips name the real tool and show sources when expanded." | HIG generative-ai "stop/edit/retry", 구체적 진행 |
| §6-2 / 탭 바 | (없음) | "In Chat, the tab bar **minimises to the current-tab circle** on scroll or while typing; the composer takes the rest of the row (iOS 26 tab bar minimise behaviour)." | 하단 크롬 17% → ≤ 10% |
| §6-3 | Drawer items include 둘러보기/보관함/나의 모시 | 드로어는 대화 목록 전용, 탭 바 목적지 중복 제거, 채팅 카드 scale .94 → .96 | 내비게이션 중복, 텍스트 스케일 흐림 |
| §6-4 | "부탁하기 capsule → press, loader, then shared-element morph … into the new task thread" | "Row tap → card morphs into a **pre-delegation sheet** (what it does, required connections, time, quota) → '맡기기' (the screen's only accent) → sheet contracts into the composer and sends." | 투명성(무엇이 필요한지 알고 맡김), 강조색 1개 |
| §0 | (암묵) | "**One accent per screen**: the primary action only. Invite, call, FAB and list actions are neutral; no coloured glows." | QA 캡처 강조색 4–6곳 |
| §3 Banner | — | "One banner at a time, queued; hold = 1.5s + 60ms × characters (2–4s); errors contract into a dot back into the island; low-risk actions get a 5s undo banner instead of a confirmation." | [S1484](https://60fps.design/shots/cobot-toast-expand-shrink-interaction), HIG notifications |
| §7 | — | "Page-sized `filter: blur()` animation is forbidden. Idle screens run no rAF loop and no running Web Animation (checked in QA)." | §5-4 |
| §2 | 표 | **변경 없음**. 60fps 스니펫 32건의 컴포넌트 스프링(t90 116–241ms, ζ .82–.94)과 일치. 새 역할 불필요 | §2-3 |

## 부록. 오늘(2026-11-11) 60fps.design 목록

> App Sites·Motion·Snippets는 전수. Shots는 2,124개라 문서에는 최신 46건(S2095–S2140)과 이 문서가 인용한 Shots 색인만 넣고, 상세를 연 672건 전체와 2,124개 전 경로는 `docs/research/assets/`에 따로 두었다.

### 부록 A. App Sites 95건(번호 내림차순, #048 결번)

| ID | 이름 | 비고 |
|---|---|---|
| A096 | [Apple HomeView Zoom Scroll Interaction](https://60fps.design/appsites/apple-homeview-zoom-scroll-interaction) | **10-14 이후 신규** |
| A095 | [Apple Safari 3D Perspective Logo Animation](https://60fps.design/appsites/apple-safari-3d-perspective-logo-animation) | **10-14 이후 신규** |
| A094 | [Apple HomeView Scroll Interaction](https://60fps.design/appsites/apple-homeview-scroll-interaction) | **10-14 이후 신규** |
| A093 | [Graphical Header Pill Tap Interaction](https://60fps.design/appsites/graphical-header-pill-tap-interaction) | 10-08 업로드 |
| A092 | [OpenAI Dots Intro Mascot Animation](https://60fps.design/appsites/openai-dots-intro-mascot-animation) | 10-08 업로드 |
| A091 | [Mike Barton Swipe Boarding Pass to Enter Interaction](https://60fps.design/appsites/mike-barton-swipe-boarding-pass-to-enter-interaction) | 10-08 업로드 |
| A090 | [Apple Mac Mini Hero Intro Logo Text Animation](https://60fps.design/appsites/apple-mac-mini-hero-intro-logo-text-animation) | 10-08 업로드 |
| A089 | [Hermeus Text Reaction Effect Interaction](https://60fps.design/appsites/hermeus-text-reaction-effect-interaction) | 10-08 업로드 |
| A088 | [Mia Headshot Stop Motion Pick Brain Explode Interaction](https://60fps.design/appsites/mia-headshot-stop-motion-pick-brain-explode-interaction) |  |
| A087 | [X Money Card Envelop Reveal Animation](https://60fps.design/appsites/x-money-card-envelop-reveal-animation) |  |
| A086 | [Vercel Sticker Darg and Drop Interaction](https://60fps.design/appsites/vercel-sticker-darg-and-drop-interaction) |  |
| A085 | [Wabi Hero Intro Asset Swap Animation](https://60fps.design/appsites/wabi-hero-intro-asset-swap-animation) |  |
| A084 | [Zero Interactive Story Scroll Tap Interaction](https://60fps.design/appsites/zero-interactive-story-scroll-tap-interaction) |  |
| A083 | [Lightspark Hero Assets Slide Scale Blur Interaction](https://60fps.design/appsites/lightspark-hero-assets-slide-scale-blur-interaction) |  |
| A082 | [System Edge Scroll Distortion Interaction](https://60fps.design/appsites/system-edge-scroll-distortion-interaction) |  |
| A081 | [Dia Footer Gradient on Scroll Interaction](https://60fps.design/appsites/dia-footer-gradient-on-scroll-interaction) |  |
| A080 | [Melius Hero 3D Assets Explode Animation](https://60fps.design/appsites/melius-hero-3d-assets-explode-animation) |  |
| A079 | [Shader Paper Shred Scroll Parallax Interaction](https://60fps.design/appsites/shader-paper-shred-scroll-parallax-interaction) |  |
| A078 | [Mintlify Hero Background Pattern Animation](https://60fps.design/appsites/mintlify-hero-background-pattern-animation) |  |
| A077 | [Taste Labs Intro 3D List Animation](https://60fps.design/appsites/taste-labs-intro-3d-list-animation) |  |
| A076 | [Bread Daily Points Card Scratch Interaction](https://60fps.design/appsites/bread-daily-points-card-scratch-interaction) |  |
| A075 | [Subframe Hero Illustration Scroll Animation](https://60fps.design/appsites/subframe-hero-illustration-scroll-animation) |  |
| A074 | [Antimetal Hero Pixel Animation](https://60fps.design/appsites/antimetal-hero-pixel-animation) |  |
| A073 | [[untitled] CD Spin Animation](https://60fps.design/appsites/untitled) |  |
| A072 | [Cora Computer Envelop Scroll Interaction](https://60fps.design/appsites/cora-computer) |  |
| A071 | [Moonfire Hero Radar Illustration Animation](https://60fps.design/appsites/moonfire-hero-radar-illustration-animation) |  |
| A070 | [Jace Thumbnail Hero Transition](https://60fps.design/appsites/jace-thumbnail-hero-transition) |  |
| A069 | [Avara Product Tap Scale Sheet Info Transition](https://60fps.design/appsites/avara-product-tap-scale-sheet-info-transition) |  |
| A068 | [Ryuki Place Cassette Play Tracks Interaction](https://60fps.design/appsites/ryuki-place-cassette-play-tracks-interaction) |  |
| A067 | [Ferrari Luce Multigraph Tabs Fade Interaction](https://60fps.design/appsites/ferrari-luce-multigraph-tabs-fade-interaction) |  |
| A066 | [WebHaptics Emoji Burst Interaction](https://60fps.design/appsites/webhaptics-emoji-burst-interaction) |  |
| A065 | [Diem Header Input Elements Animation](https://60fps.design/appsites/diem-header-input-elements-animation) |  |
| A064 | [Shoe Finder 3D Space Grid Scroll Interaction](https://60fps.design/appsites/shoe-finder-3d-space-grid-scroll-interaction) |  |
| A063 | [The Steve Jobs Archive Chapter Scroll Zoom Interaction](https://60fps.design/appsites/the-steve-jobs-archive-chapter-scroll-zoom-interaction) |  |
| A062 | [ui.sh Header Text Animation](https://60fps.design/appsites/ui.sh-header-text-animation) |  |
| A061 | [Jesko Jets 3D Flight Overlay Scroll Interaction](https://60fps.design/appsites/jesko-jets-3d-flight-overlay-scroll-interaction) |  |
| A060 | [Jesko Jets 3D Flight Window Parallax Scroll Interaction](https://60fps.design/appsites/jesko-jets-3d-flight-window-parallax-scroll-interaction) |  |
| A059 | [Fundable Header Logos Reveal Spin Animation](https://60fps.design/appsites/fundable-header-logos-reveal-spin-animation) |  |
| A058 | [Cosmos Landing Section Scroll Interaction](https://60fps.design/appsites/cosmos-landing-section-scroll-interaction) |  |
| A057 | [Notion Header Illustration Animation](https://60fps.design/appsites/notion-header-illustration-animation) |  |
| A056 | [Shop 3D Illustration Timed Carousel Interaction](https://60fps.design/appsites/shop-3d-illustration-timed-carousel-interaction) |  |
| A055 | [Dropbox Dash Scroll Animation](https://60fps.design/appsites/dropbox-dash-scroll-animation) |  |
| A054 | [Dropbox Dash Carousel Swipe Morph Interaction](https://60fps.design/appsites/dropbox-dash-carousel-swipe-morph-interaction) |  |
| A053 | [Stripe Sessions Speakers Card Swipe Tilt Interaction](https://60fps.design/appsites/stripe-sessions-speakers-card-swipe-tilt-interaction) |  |
| A052 | [Real Food Scroll Morph Animation](https://60fps.design/appsites/real-food-scroll-morph-animation) |  |
| A051 | [Aave Tab Scale Interaction](https://60fps.design/appsites/aave-tab-scale-interaction) |  |
| A050 | [Agentic UI Logo Glitch Spin Animation](https://60fps.design/appsites/agentic-ui-logo-glitch-spin-animation) |  |
| A049 | [Apple iMac Morph Zoom Animation](https://60fps.design/appsites/apple-imac-morph-zoom-animation) |  |
| A047 | [Linear Logo Blur Scale Glow Animation](https://60fps.design/appsites/linear-logo-blur-scale-glow-animation) |  |
| A046 | [Visitors 3D Globe Interaction](https://60fps.design/appsites/visitors-3d-globe-interaction) |  |
| A045 | [Interface Craft Card Stack Swipe Interaction](https://60fps.design/appsites/interface-craft-card-stack-swipe-interaction) |  |
| A044 | [Uncommon Image Generating Blur Animation](https://60fps.design/appsites/uncommon-image-generating-blur-animation) |  |
| A043 | [Desktop FM 3D Disk Spin Swipe Interaction](https://60fps.design/appsites/desktop-fm-3d-disk-spin-swipe-interaction) |  |
| A042 | [Shopify Winter 26 3D Records Pop In Out Interaction](https://60fps.design/appsites/shopify-winter-26-3d-records-pop-in-out-interaction) |  |
| A041 | [Shopify Winter 26 Text Animation](https://60fps.design/appsites/shopify-winter-26-text-animation) |  |
| A040 | [Super Random Studio Toggle Read Receipts Interaction](https://60fps.design/appsites/super-random-studio-toggle-read-receipts-interaction) |  |
| A039 | [Atlas Card Zoom Morph Text Animation](https://60fps.design/appsites/atlas-card-zoom-morph-text-animation) |  |
| A038 | [Linear Plan Compass Horizontal Scroll Interaction](https://60fps.design/appsites/linear-plan-compass-horizontal-scroll-interaction) |  |
| A037 | [Cash App 3D Card Spin on Scroll Interaction](https://60fps.design/appsites/cash-app-3d-card-spin-on-scroll-interaction) |  |
| A036 | [Apple iPhone Air Hand Slide Hold Animation](https://60fps.design/appsites/apple-iphone-air-hand-slide-hold-animation) |  |
| A035 | [Cursor Year in Review Timeline Animations](https://60fps.design/appsites/cursor-year-in-review-timeline-animations) |  |
| A034 | [Todd Hamilton Retro Mac Page Zoom Interaction](https://60fps.design/appsites/todd-hamilton-retro-mac-page-zoom-interaction) |  |
| A033 | [Cash App Canvas Scroll Interaction](https://60fps.design/appsites/cash-app-canvas-scroll-interaction) |  |
| A032 | [Net Contextual Elements Text Animation](https://60fps.design/appsites/net-contextual-elements-text-animation) |  |
| A031 | [Framer Awards 3D Cash Spin Animation](https://60fps.design/appsites/framer-awards-3d-cash-spin-animation) |  |
| A030 | [Rivian Modes Swipe Morph to Scenes Interaction](https://60fps.design/appsites/rivian-modes-swipe-morph-to-scenes-interaction) |  |
| A029 | [Charmin Kumar Vemula 3D Card Stack Swipe Interaction](https://60fps.design/appsites/charmin-kumar-vemula-3d-card-stack-swipe-interaction) |  |
| A028 | [Shopify Winter 26 Scroll Sparkle Morph Interaction](https://60fps.design/appsites/shopify-winter-26-scroll-sparkle-morph-interaction) |  |
| A027 | [Framer 3D Shinny Coin Flip Animation](https://60fps.design/appsites/framer-3d-shinny-coin-flip-animation) |  |
| A026 | [Atlas Card Header Video Zoom Transitions](https://60fps.design/appsites/atlas-card-header-video-zoom-transitions) |  |
| A025 | [Apple Watch Morph Transition](https://60fps.design/appsites/apple-watch-morph-transition) |  |
| A024 | [Sunflower 3D Footer Animation](https://60fps.design/appsites/sunflower-3d-footer-animation) |  |
| A023 | [Pool Scroll Header Sticky Animation](https://60fps.design/appsites/pool-scroll-header-sticky-animation) |  |
| A022 | [Atlas Card 3D Reveal Globe Animation](https://60fps.design/appsites/atlas-card-3d-reveal-globe-animation) |  |
| A021 | [Evervault 3D Card Swirl and Spin Animation](https://60fps.design/appsites/evervault-3d-card-swirl-and-spin-animation) |  |
| A020 | [Evervault Circular Slider Text Encryption Animation](https://60fps.design/appsites/evervault-circular-slider-text-encryption-animation) |  |
| A019 | [Evervault Card Scan Animation](https://60fps.design/appsites/evervault-card-scan-animation) |  |
| A018 | [Dub Slide to Compare Interaction](https://60fps.design/appsites/dub-slide-to-compare-interaction) |  |
| A017 | [Alter 3D Book Interaction](https://60fps.design/appsites/alter-3d-book-interaction) |  |
| A016 | [Air Logo Flip to Footer Path Animation](https://60fps.design/appsites/air-logo-flip-to-footer-path-animation) |  |
| A015 | [Super Random Studio Venn Diagram Swipe to Generate Interaction](https://60fps.design/appsites/super-random-studio-venn-diagram-swipe-to-generate-interaction) |  |
| A014 | [Sequence Polaroid Photos Expand Interaction](https://60fps.design/appsites/sequence-polaroid-photos-expand-interaction) |  |
| A013 | [Rube Header Text Animation](https://60fps.design/appsites/rube-header-text-animation) |  |
| A012 | [Inkwell Spiral Split Animation](https://60fps.design/appsites/inkwell-spiral-split-animation) |  |
| A011 | [Collins Tab Icon Animation](https://60fps.design/appsites/collins-tab-icon-animation) |  |
| A010 | [Wildy Riftian Text Animation](https://60fps.design/appsites/wildy-riftian-text-animation) |  |
| A009 | [Nothing to Watch Voronoi Diagram Swipe Interaction](https://60fps.design/appsites/nothing-to-watch-voronoi-diagram-swipe-interaction) |  |
| A008 | [Dropbox Brand Guidelines Menu Interaction](https://60fps.design/appsites/dropbox-brand-guidelines-menu-interaction) |  |
| A007 | [Stripe Press 3D Book Navigation Scale Interaction](https://60fps.design/appsites/stripe-press-3d-book-navigation-scale-interaction) |  |
| A006 | [Stripe Press 3D Book Stack Morph Interaction](https://60fps.design/appsites/stripe-press-3d-book-stack-morph-interaction) |  |
| A005 | [Stripe Press 3D Book Rotation Interaction](https://60fps.design/appsites/stripe-press-3d-book-rotation-interaction) |  |
| A004 | [Skiper UI Accordion Interaction](https://60fps.design/appsites/skiper-ui-accordion-interaction) |  |
| A003 | [Ribbit Book Flip on Swipe Down Interaction](https://60fps.design/appsites/ribbit-book-flip-on-swipe-down-interaction) |  |
| A002 | [Superlocal Playful Footer Elements Flick Interaction](https://60fps.design/appsites/superlocal-playful-footer-elements-flick-interaction) |  |
| A001 | [Lando Norris Helmet Reveal Swipe Interaction](https://60fps.design/appsites/lando-norris-helmet-reveal-swipe-interaction) |  |

### 부록 B. Motion 83건(1차 조사 번호, 10-05 이후 변동 없음)

| ID | 이름 |
|---|---|
| M001 | [Runnit  /  Robert James Powell](https://60fps.design/motion/runnit-by-robert-james-powell) |
| M002 | [Findest  /  Verve](https://60fps.design/motion/findest-by-verve) |
| M003 | [Etsy  /  SYLVAIN](https://60fps.design/motion/etsy-by-sylvain) |
| M004 | [Sprint Valley  /  OHMY](https://60fps.design/motion/sprint-valley-by-ohmy) |
| M005 | [Gemini 3  /  Art&Graft](https://60fps.design/motion/gemini-3-by-art-graft) |
| M006 | [Digs  /  Saint Urbain](https://60fps.design/motion/digs-by-saint-urbain) |
| M007 | [Grafana  /  HEX](https://60fps.design/motion/grafana-by-hex) |
| M008 | [Paul Smith  /  Limesharp](https://60fps.design/motion/paul-smith-by-limesharp) |
| M009 | [Tilt  /  Ragged Edge](https://60fps.design/motion/tilt-by-ragged-edge) |
| M010 | [Indicium AI  /  Justified Studio](https://60fps.design/motion/indicium-ai-by-justified-studio) |
| M011 | [Mews  /  Koto](https://60fps.design/motion/mews-by-koto) |
| M012 | [Avenga  /  Studio Najbrt](https://60fps.design/motion/avenga-by-studio-najbrt) |
| M013 | [QT Hotels  /  Houston Group](https://60fps.design/motion/qt-hotels-by-houston-group) |
| M014 | [Sky Money  /  Clay](https://60fps.design/motion/sky-money-by-clay) |
| M015 | [855-HOW-TO-QUIT  /  Raw Materials](https://60fps.design/motion/855-how-to-quit-by-raw-materials) |
| M016 | [Arrive  /  Bold Scandinavia](https://60fps.design/motion/arrive-by-bold-scandinavia) |
| M017 | [GrowHappy  /  Wedge](https://60fps.design/motion/growhappy-by-wedge) |
| M018 | [Talq  /  Area Studio](https://60fps.design/motion/talq-by-area-studio) |
| M019 | [Work With Island  /  Bruno](https://60fps.design/motion/work-with-island-by-bruno) |
| M020 | [Shareman  /  Hymn](https://60fps.design/motion/shareman-by-hymn) |
| M021 | [Olla  /  Recent](https://60fps.design/motion/olla-by-recent) |
| M022 | [Sunday  /  Standard Projects](https://60fps.design/motion/sunday-by-standard-projects) |
| M023 | [Joby Aviation  /  TinyWins](https://60fps.design/motion/joby-aviation-by-tinywins) |
| M024 | [Skyline  /  Mude](https://60fps.design/motion/skyline-by-mude) |
| M025 | [Summ  /  Accompany](https://60fps.design/motion/summ-by-accompany) |
| M026 | [Composio  /  HEX](https://60fps.design/motion/composio-by-hex) |
| M027 | [Brightfield  /  Justified Studio](https://60fps.design/motion/brightfield-by-justified-studio) |
| M028 | [Magnific  /  AREA 17](https://60fps.design/motion/magnific-by-area-17) |
| M029 | [Raycash  /  Ashfall](https://60fps.design/motion/raycash-by-ashfall) |
| M030 | [Threads  /  Studio NARI](https://60fps.design/motion/threads-by-studio-nari) |
| M031 | [Holographik  /  Veda](https://60fps.design/motion/holographik-by-veda) |
| M032 | [Stack Overflow  /  Koto](https://60fps.design/motion/stack-overflow-by-koto) |
| M033 | [Ivo  /  Motto](https://60fps.design/motion/ivo-by-motto) |
| M034 | [Cursor  /  Kimera](https://60fps.design/motion/kimera) |
| M035 | [Amazon  /  Koto](https://60fps.design/motion/amazon-by-koto) |
| M036 | [Alipay+  /  Further](https://60fps.design/motion/alipay-by-further) |
| M037 | [Salesforce  /  Athletics](https://60fps.design/motion/salesforce-by-athletics) |
| M038 | [Coda  /  Koto](https://60fps.design/motion/coda-by-koto) |
| M039 | [Yazio  /  Koto](https://60fps.design/motion/yazio-by-koto) |
| M040 | [Replit  /  Oddfellows](https://60fps.design/motion/replit-by-oddfellows) |
| M041 | [Calendly  /  Smith & Diction](https://60fps.design/motion/calendly-by-smith-diction) |
| M042 | [Reactor  /  Lovework Studio](https://60fps.design/motion/reactor-by-lovework-studio) |
| M043 | [Cob  /  Saint-Urbain](https://60fps.design/motion/cob-by-saint-urbain) |
| M044 | [Fauna Robotics  /  O0](https://60fps.design/motion/fauna-robotics-by-o0) |
| M045 | [Cofounder  /  Altalogy](https://60fps.design/motion/cofounder-by-altalogy) |
| M046 | [Duffle  /  BR*Studio](https://60fps.design/motion/duffle-by-br-studio) |
| M047 | [Expensify  /  The Collected Works](https://60fps.design/motion/expensify-by-the-collected-works) |
| M048 | [Silo  /  Gold Front](https://60fps.design/motion/silo-by-gold-front) |
| M049 | [Lovable  /  Primary](https://60fps.design/motion/lovable-by-primary) |
| M050 | [Superhuman  /  Smith & Diction](https://60fps.design/motion/superhuman-by-smith-diction) |
| M051 | [TwelveLabs  /  Pentagram](https://60fps.design/motion/twelvelabs-by-pentagram) |
| M052 | [PayPal  /  Pentagram](https://60fps.design/motion/paypal-by-pentagram) |
| M053 | [Anthropic  /  Geist](https://60fps.design/motion/anthropic-by-geist) |
| M054 | [OpenAI  /  Studiodumbar](https://60fps.design/motion/openai-by-studiodumbar) |
| M055 | [Flip Lingoes  /  Ozon Studio](https://60fps.design/motion/flip-lingoes-by-ozon-studio) |
| M056 | [Premier League  /  Nomad Studio](https://60fps.design/motion/premier-league-by-nomad-studio) |
| M057 | [Stripe  /  Play Studio](https://60fps.design/motion/stripe-by-play-studio) |
| M058 | [BIXI  /  Principal](https://60fps.design/motion/bixi-by-principal) |
| M059 | [ElevenLabs  /  THRU](https://60fps.design/motion/elevenlabs-by-thru) |
| M060 | [Verston  /  This Is Bond](https://60fps.design/motion/verston-by-thisisbond) |
| M061 | [Cash App](https://60fps.design/motion/cash-app) |
| M062 | [Wabi  /  Studio Dumbar](https://60fps.design/motion/wabi-by-studiodumbar) |
| M063 | [Headspace  /  Metalab](https://60fps.design/motion/headspace-by-metalab) |
| M064 | [Eventbrite  /  BUCK](https://60fps.design/motion/eventbrite-by-buck) |
| M065 | [Perplexity  /  Studio Freight](https://60fps.design/motion/perplexity-comet-browser-by-studio-freight) |
| M066 | [Granola  /  Ragged Edge](https://60fps.design/motion/granola-by-ragged-edge) |
| M067 | [Conduit  /  Hex](https://60fps.design/motion/conduit-by-hex) |
| M068 | [Brex  /  Studio Freight](https://60fps.design/motion/brex-by-studio-freight) |
| M069 | [Mailchimp  /  COLLINS](https://60fps.design/motion/mailchimp-by-collins) |
| M070 | [Brandmelder  /  NEW STANDARD.S](https://60fps.design/motion/brandmelder-by-new-standard-s) |
| M071 | [Lebara  /  Verve](https://60fps.design/motion/lebara-by-verve) |
| M072 | [Univers  /  Pentagram](https://60fps.design/motion/univers-by-pentagram) |
| M073 | [Coinbase  /  Koto](https://60fps.design/motion/coinbase-by-koto) |
| M074 | [Google I/O  /  Little Troop](https://60fps.design/motion/google-i-o-by-little-troop) |
| M075 | [Shop  /  Porto Rocha](https://60fps.design/motion/shop-by-porto-rocha) |
| M076 | [Twitch  /  Porto Rocha](https://60fps.design/motion/twitch-by-porto-rocha) |
| M077 | [Rivian  /  Pentagram](https://60fps.design/motion/rivian-by-pentagram) |
| M078 | [Lyft  /  Koto](https://60fps.design/motion/lyft-by-koto) |
| M079 | [Wise  /  Ragged Edge](https://60fps.design/motion/wise-by-ragged-edge) |
| M080 | [Tinder  /  Porto Rocha](https://60fps.design/motion/tinder-by-porto-rocha) |
| M081 | [MachineX  /  Koto](https://60fps.design/motion/machinex-by-koto) |
| M082 | [Betr  /  Motto](https://60fps.design/motion/betr-by-motto) |
| M083 | [Gusto  /  Smith & Diction](https://60fps.design/motion/gusto-by-smith-diction) |

### 부록 C. Snippets 32건

| ID | 이름 | 원본 앱 | 업로드 | 비고 |
|---|---|---|---|---|
| N032 | [Subscribe Button Change Interaction](https://60fps.design/snippets/subscribe-button-change-interaction) | Queue | 2026-10-19 | **10-14 이후 신규** |
| N031 | [Graph Scrub Highlight Glow Interaction](https://60fps.design/snippets/graph-scrub-highlight-glow-interaction) | Revolut | 2026-10-19 | **10-14 이후 신규** |
| N030 | [Dropdown Menu Expand Morph Interaction](https://60fps.design/snippets/dropdown-menu-expand-morph-interaction) | Circle | 2026-10-19 | **10-14 이후 신규** |
| N029 | [Cancel Button Expand to Confirm Interaction](https://60fps.design/snippets/cancel-button-expand-to-confirm-interaction) | [untitled] | 2026-10-19 | **10-14 이후 신규** |
| N028 | [Comma Jump Number Input Interaction](https://60fps.design/snippets/comma-jump-number-input-interaction) | Family | 2026-10-19 | **10-14 이후 신규** |
| N027 | [Tactile Button Interaction](https://60fps.design/snippets/tactile-button-interaction) | Duolingo | 2026-10-19 | **10-14 이후 신규** |
| N026 | [Button Border Stroke Pulse Animation](https://60fps.design/snippets/button-border-stroke-pulse-animation) | Revolut | 2026-10-19 | **10-14 이후 신규** |
| N025 | [Plus to Tick Button Animation](https://60fps.design/snippets/plus-to-tick-button-animation) | Apple TV | 2026-10-19 | **10-14 이후 신규** |
| N024 | [Tap to Hold Button Pulse Morph Interaction](https://60fps.design/snippets/tap-to-hold-button-pulse-morph-interaction) | Monogram | 2026-10-19 | **10-14 이후 신규** |
| N023 | [Free Trial Switch Amount Change Interaction](https://60fps.design/snippets/free-trial-switch-amount-change-interaction) | Exoplan | 2026-10-19 | **10-14 이후 신규** |
| N022 | [Delete to Confirm Button Interaction](https://60fps.design/snippets/delete-to-confirm-button-interaction) | Five Cents | 2026-10-19 | **10-14 이후 신규** |
| N021 | [Card Fire Burn Particle Effect Interaction](https://60fps.design/snippets/card-fire-burn-particle-effect-interaction) | How We Feel | 2026-10-19 | **10-14 이후 신규** |
| N020 | [Selection to Illustration Animation](https://60fps.design/snippets/selection-to-illustration-animation) | Revolut | 2026-10-13 |  |
| N019 | [Spin to Circle Animation](https://60fps.design/snippets/spin-to-circle-animation) | ChatGPT | 2026-10-13 |  |
| N018 | [Bottom Tabs Active Tab Expansion Interaction](https://60fps.design/snippets/bottom-tabs-active-tab-expansion-interaction) | Neuecast | 2026-10-13 |  |
| N017 | [Bottom Sheet Detail Expansion Interaction](https://60fps.design/snippets/bottom-sheet-detail-expansion-interaction) | Family | 2026-10-13 |  |
| N016 | [Card 3D Flip Interaction](https://60fps.design/snippets/card-3d-flip-interaction) | How We Feel | 2026-10-13 |  |
| N015 | [List Fade Up from Down Interaction](https://60fps.design/snippets/list-fade-up-from-down-interaction) | Vakitler | 2026-10-13 |  |
| N014 | [See all Menu Expand Interaction](https://60fps.design/snippets/see-all-menu-expand-interaction) | Captions | 2026-10-09 |  |
| N013 | [Mini Player Play and Scrub Interaction](https://60fps.design/snippets/mini-player-play-and-scrub-interaction) | [untitled] | 2026-10-09 |  |
| N012 | [Keyboard to Input Morph Interaction](https://60fps.design/snippets/keyboard-to-input-morph-interaction) | Monogram | 2026-10-09 |  |
| N011 | [Hide Sensitive Number Interaction](https://60fps.design/snippets/hide-sensitive-number-interaction) | Family | 2026-10-09 |  |
| N010 | [OTP Input Pulse Fill Success Interaction](https://60fps.design/snippets/otp-input-pulse-fill-success-interaction) | Toss | 2026-10-09 |  |
| N009 | [Continue Button to Tick Animation](https://60fps.design/snippets/continue-button-to-tick-animation) | CRED | 2026-10-05 |  |
| N008 | [Line Graph Morph Interaction](https://60fps.design/snippets/line-graph-morph-interaction) | Family | 2026-10-05 |  |
| N007 | [Hold to Commit Button Interaction](https://60fps.design/snippets/hold-to-commit-button-interaction) | Opal | 2026-10-05 |  |
| N006 | [Number Flip with Reflection Interaction](https://60fps.design/snippets/number-flip-with-reflection-interaction) | Push | 2026-10-05 |  |
| N005 | [Forward Toast Icon Animation](https://60fps.design/snippets/forward-toast-icon-animation) | Telegram | 2026-10-05 |  |
| N004 | [Plan Switch Card Expand Interaction](https://60fps.design/snippets/plan-switch-card-expand-interaction) | AllTrails | 2026-10-05 |  |
| N003 | [List Item Accordion Expand Interaction](https://60fps.design/snippets/list-item-accordion-expand-interaction) | Amie | 2026-10-05 |  |
| N002 | [Circle Progress Fill Interaction](https://60fps.design/snippets/circle-progress-fill-interaction) | GrowPal | 2026-10-05 |  |
| N001 | [Group Stage Table Timeline Tab Interaction](https://60fps.design/snippets/group-stage-table-timeline-tab-interaction) | Apple Sports | 2026-10-05 |  |

### 부록 D. Shots 최신 46건(S2095–S2140; S2110 이후 ≈ 10-14 이후 신규, 추정)

| ID | 이름 | 카테고리 |
|---|---|---|
| S2140 | [Apple Health Longevity Intro Animation](https://60fps.design/shots/apple-health-longevity-intro-animation) | Health & Fitness |
| S2139 | [Runmo Lab Pulse Heart ECG Interaction](https://60fps.design/shots/runmo-lab-pulse-heart-ecg-interaction) | Health & Fitness |
| S2138 | [Revolut Card Ready Animation](https://60fps.design/shots/revolut-card-ready-animation) | Finance |
| S2137 | [Plasma Card Setup Animation](https://60fps.design/shots/plasma-card-setup-animation) | Finance |
| S2136 | [DOOD Splash Animation](https://60fps.design/shots/dood-splash-animation) | Lifestyle |
| S2135 | [Runmo Days Counter Interaction](https://60fps.design/shots/runmo-days-counter-interaction) | Health & Fitness |
| S2134 | [Runmo Distance Wheel Fill Interaction](https://60fps.design/shots/runmo-distance-wheel-fill-interaction) | Health & Fitness |
| S2133 | [Runmo Fresh Start Loader Interaction](https://60fps.design/shots/runmo-fresh-start-loader-interaction) | Health & Fitness |
| S2132 | [Whatnot Splash Animation](https://60fps.design/shots/whatnot-splash-animation) | Shopping |
| S2131 | [Circle Splash Bubbles Pop Interaction](https://60fps.design/shots/circle-splash-bubbles-pop-interaction) | Lifestyle |
| S2130 | [Brick Intro Value Prop Text Flip Interaction](https://60fps.design/shots/brick-intro-value-prop-text-flip-interaction) | Productivity |
| S2129 | [Runmo Intro Value Prop Carousel Interaction](https://60fps.design/shots/runmo-intro-value-prop-carousel-interaction) | Health & Fitness |
| S2128 | [Runmo Drag to Adjust Distance Wheel Interaction](https://60fps.design/shots/runmo-drag-to-adjust-distance-wheel-interaction) | Health & Fitness |
| S2127 | [Runmo Splash Animation](https://60fps.design/shots/runmo-splash-animation) | Health & Fitness |
| S2126 | [Plasma Duo Style Bottom Sheet Open Interaction](https://60fps.design/shots/plasma-duo-style-bottom-sheet-open-interaction) | Finance |
| S2125 | [Apple App Store App Page Header Asset Animation](https://60fps.design/shots/apple-app-store-app-page-header-asset-animation) | Utilities |
| S2124 | [Duolingo Sparkle Sculpt Pop Interaction](https://60fps.design/shots/duolingo-sparkle-sculpt-pop-interaction) | Education |
| S2123 | [Circle New Wallet Claim Balance Interaction](https://60fps.design/shots/circle-new-wallet-claim-balance-interaction) | Lifestyle |
| S2122 | [CRED Ticket Pop on Slider Interaction](https://60fps.design/shots/cred-ticket-pop-on-slider-interaction) | Finance |
| S2121 | [CRED Printing Tickets Shuffle Interaction](https://60fps.design/shots/cred-printing-tickets-shuffle-interaction) | Finance |
| S2120 | [Revolut Create Close Pocket Interaction](https://60fps.design/shots/revolut-create-close-pocket-interaction) | Finance |
| S2119 | [Revolut Select Plan Tab Scroll Interaction](https://60fps.design/shots/revolut-select-plan-tab-scroll-interaction) | Finance |
| S2118 | [Revolut RevPoints Feature Coachmark Border Pulse Interaction](https://60fps.design/shots/revolut-revpoints-feature-coachmark-border-pulse-interaction) | Finance |
| S2117 | [Revolut Feature Buttons Coachmark Border Pulse Interaction](https://60fps.design/shots/revolut-feature-buttons-coachmark-border-pulse-interaction) | Finance |
| S2116 | [Revolut Create Delete Pocket Interaction](https://60fps.design/shots/revolut-create-delete-pocket-interaction) | Finance |
| S2115 | [Revolut Single Use Pulse Card Sweep Morph Animation](https://60fps.design/shots/revolut-single-use-pulse-card-sweep-morph-animation) | Finance |
| S2114 | [Duolingo Battery Fill Up Interaction](https://60fps.design/shots/duolingo-battery-fill-up-interaction) | Education |
| S2113 | [Threads Splash Logo Animation](https://60fps.design/shots/threads-splash-logo-animation) | Social Networking |
| S2112 | [Run Receipt Signature Interaction](https://60fps.design/shots/run-receipt-signature-interaction) | Health & Fitness |
| S2111 | [Revolut Splash Intro Video Sequence](https://60fps.design/shots/revolut-splash-intro-video-sequence) | Finance |
| S2110 | [X Campaign Hashtag Based Grok Bot Like Button Interaction](https://60fps.design/shots/x-campaign-hashtag-based-grok-bot-like-button-interaction) | News |
| S2109 | [Platen Typewriter Intro How to Interaction](https://60fps.design/shots/platen-typewriter-intro-how-to-interaction) | Productivity |
| S2108 | [Uber Search Border Highlight Animation](https://60fps.design/shots/uber-search-border-highlight-animation) | Travel |
| S2107 | [CRED Autopay Bills Stack Animation](https://60fps.design/shots/cred-autopay-bills-stack-animation) | Finance |
| S2106 | [Aave Intro Value Prop 3D Clock Animation](https://60fps.design/shots/aave-intro-value-prop-3d-clock-animation) | Finance |
| S2105 | [Aave Intro Value Prop 3D Lock Animation](https://60fps.design/shots/aave-intro-value-prop-3d-lock-animation) | Finance |
| S2104 | [Aave Intro Value Prop 3D Coin Spin Animation](https://60fps.design/shots/aave-intro-value-prop-3d-coin-spin-animation) | Finance |
| S2103 | [Uber Loading Animation](https://60fps.design/shots/uber-loading-animation) | Travel |
| S2102 | [District Weekend Pick Card Scroll Snap Selection Interaction](https://60fps.design/shots/district-weekend-pick-card-scroll-snap-selection-interaction) | Lifestyle |
| S2101 | [Apple Customize Control Center How to Animation](https://60fps.design/shots/apple-customize-control-center-how-to-animation) |  |
| S2100 | [X NFL Games Tab Switch Interaction](https://60fps.design/shots/x-nfl-games-tab-switch-interaction) | News |
| S2099 | [Netflix Poster Reflection on Bottom Tabs Interaction](https://60fps.design/shots/netflix-poster-reflection-on-bottom-tabs-interaction) | Entertainment |
| S2098 | [CRED Swipe to Pay Interaction](https://60fps.design/shots/cred-swipe-to-pay-interaction) | Finance |
| S2097 | [Revolut Number of Transactions Interaction](https://60fps.design/shots/revolut-number-of-transactions-interaction) | Finance |
| S2096 | [Monologue Intro Animation](https://60fps.design/shots/monologue-intro-animation) | Productivity |
| S2095 | [Zomato No Internet Offline Game Interaction](https://60fps.design/shots/zomato-no-internet-offline-game-interaction) | Food & Drink |

### 부록 E. 이 문서가 인용한 Shots 색인

| ID | 이름 |
|---|---|
| S0009 | [Arc Search Long Press Assistant](https://60fps.design/shots/arc-search-long-press-assistant) |
| S0052 | [ChatGPT Listening](https://60fps.design/shots/chatgpt-listening) |
| S0067 | [Arc Search AI Generation Loader](https://60fps.design/shots/arc-search-ai-generation-loader) |
| S0558 | [FocusPomo Hold to Stop Interaction](https://60fps.design/shots/focuspomo-hold-to-stop-interaction) |
| S0780 | [Family Approvals Empty State Floating Lock Animation](https://60fps.design/shots/family-approvals-empty-state-floating-lock-animation) |
| S0821 | [Apple Pull Down for Spotlight Interaction](https://60fps.design/shots/apple-pull-down-for-spotlight-interaction) |
| S0957 | [Remy AI Chat Interaction](https://60fps.design/shots/remy-ai-chat-interaction) |
| S0959 | [Remy AI Analysis Checklist Animation](https://60fps.design/shots/remy-ai-analysis-checklist-animation) |
| S0961 | [Remy AI Analysis Chat Interaction](https://60fps.design/shots/remy-ai-analysis-chat-interaction) |
| S1015 | [Grok Chat Menu Interaction](https://60fps.design/shots/grok-chat-menu-interaction) |
| S1025 | [Grok New Chat Suggestions Pop Interaction](https://60fps.design/shots/grok-new-chat-suggestions-pop-interaction) |
| S1164 | [Perplexity Number Flip Animation](https://60fps.design/shots/perplexity-number-flip-animation) |
| S1167 | [Toss Accept Terms Check Interaction](https://60fps.design/shots/toss-accept-terms-check-interaction) |
| S1220 | [Toss OTP Successful Animation](https://60fps.design/shots/toss-otp-successful-animation) |
| S1253 | [Finma Private Secure Lock Onboarding Animation](https://60fps.design/shots/finma-private-secure-lock-animation) |
| S1261 | [Airbnb Search Tab Interaction](https://60fps.design/shots/airbnb-search-tab-interaction) |
| S1277 | [Notion AI Sheet Intro Action Trail Transition](https://60fps.design/shots/notion-ai-sheet-intro-action-trail-transition) |
| S1289 | [Honk Call Connect Pulse Animation](https://60fps.design/shots/honk-call-connect-pulse-animation) |
| S1300 | [Honk Delete Account Sheet Stack Interaction](https://60fps.design/shots/honk-delete-account-sheet-stack-interaction) |
| S1301 | [Honk Typing Pill Slide Interaction](https://60fps.design/shots/honk-typing-pill-slide-interaction) |
| S1317 | [Honk Chat Bubble Dynamic Resize Back and Forth Interaction](https://60fps.design/shots/honk-chat-bubble-dynamic-resize-back-and-forth-interaction) |
| S1359 | [Family Button Morph to Sheet Button Interaction](https://60fps.design/shots/family-button-morph-to-sheet-button-interaction) |
| S1365 | [Family Button to Sheet Button Morph Interaction](https://60fps.design/shots/family-button-to-sheet-button-morph-interaction) |
| S1368 | [Family Share Feedback Sheet Morph Interaction](https://60fps.design/shots/family-share-feedback-sheet-morph-interaction) |
| S1375 | [Family Dynamic Sheet Morph Interaction](https://60fps.design/shots/family-dynamic-sheet-morph-interaction) |
| S1379 | [Family Contextual Sheet Buttom Morph Interaction](https://60fps.design/shots/family-contextual-sheet-buttom-morph-interaction) |
| S1391 | [Family Contextual Spinner Move to Sheet Morph Interaction](https://60fps.design/shots/family-contextual-spinner-move-to-sheet-morph-interaction) |
| S1394 | [Family Sequence of Sheets Vary in Height Interaction](https://60fps.design/shots/family-sequence-of-sheets-vary-in-height-interaction) |
| S1396 | [Family Spinner Move to Bottom Navigation on Confirm Transaction](https://60fps.design/shots/family-spinner-move-to-bottom-navigation-on-confirm-transaction) |
| S1402 | [Family Entering Values to Confirm Screen Morph Interaction](https://60fps.design/shots/family-entering-values-to-confirm-screen-morph-interaction) |
| S1455 | [Uber Ride Verified Tick in Sheet Animation](https://60fps.design/shots/uber-ride-verified-tick-in-sheet-animation) |
| S1476 | [Google AI Mode Search Morph Interaction](https://60fps.design/shots/google-ai-mode-search-morph-interaction) |
| S1484 | [Cobot Toast Expand Shrink Interaction](https://60fps.design/shots/cobot-toast-expand-shrink-interaction) |
| S1526 | [Grok AI Voice Download Spinner Loader Animation](https://60fps.design/shots/grok-ai-voice-download-spinner-loader-animation) |
| S1541 | [Grok Pull Down to Go Back Interaction](https://60fps.design/shots/grok-pull-down-to-go-back-interaction) |
| S1564 | [Perplexity Model Selection Sheet Morph Interaction](https://60fps.design/shots/perplexity-model-selection-sheet-morph-interaction) |
| S1567 | [Queue Ask AI Chat Random Prompt Interaction](https://60fps.design/shots/queue-ask-ai-chat-random-prompt-interaction) |
| S1586 | [Swiggy Purchased Loader to Check Mark Animation](https://60fps.design/shots/swiggy-purchased-loader-to-check-mark-animation) |
| S1634 | [Fuse Delete Wallet Sheet Checkbox Interaction](https://60fps.design/shots/fuse-delete-wallet-sheet-checkbox-interaction) |
| S1640 | [Perplexity Conversation Word Sentence Audio Interaction](https://60fps.design/shots/perplexity-conversation-word-sentence-audio-interaction) |
| S1683 | [Apple Measure Liquid Glass Level Interaction](https://60fps.design/shots/apple-measure-liquid-glass-level-interaction) |
| S1710 | [Wabi Chat Suggestion Swipe Cards Carousel Interaction](https://60fps.design/shots/wabi-chat-suggestion-swipe-cards-carousel-interaction) |
| S1820 | [Quartr Selection Liquid Glass Pulse Interaction](https://60fps.design/shots/quartr-selection-liquid-glass-pulse-interaction) |
| S1839 | [Craft Cursor Seek Liquid Glass Magnify Interaction](https://60fps.design/shots/craft-cursor-seek-liquid-glass-magnify-interaction) |
| S1848 | [Eimi Generating Card Preview Morph Pop Scale in Sheet Animation](https://60fps.design/shots/eimi-generating-card-preview-morph-pop-scale-in-sheet-animation) |
| S1861 | [District Ask AI Intro Sheet Animation](https://60fps.design/shots/district-ask-ai-intro-sheet-animation) |
| S1922 | [Swiggy Chat Response Loading Animation](https://60fps.design/shots/swiggy-chat-response-loading-animation) |
| S1933 | [District Something Went Wrong Empty State Animation](https://60fps.design/shots/district-something-went-wrong-empty-state-animation) |
| S1934 | [Fold Spaces Empty State Animation](https://60fps.design/shots/fold-spaces-empty-state-animation) |
| S1935 | [Fold Cards Empty State Animation](https://60fps.design/shots/fold-cards-empty-state-animation) |
| S1945 | [Avec Hold and Speak Interaction](https://60fps.design/shots/avec-hold-and-speak-interaction) |
| S1952 | [Grok App Icons in Sheet Arc Animation](https://60fps.design/shots/grok-app-icons-in-sheet-arc-animation) |
| S1954 | [Google Gemini Response Gradient Animation](https://60fps.design/shots/google-gemini-response-gradient-animation) |
| S1972 | [Claude Code Empty State Mascot Illustration Animation](https://60fps.design/shots/claude-code-empty-state-mascot-illustration-animation) |
| S1977 | [ChatGPT Intelligence Picker Long Press Slider Interaction](https://60fps.design/shots/chatgpt-intelligence-picker-long-press-slider-interaction) |
| S1990 | [Grok Connect Tools Logo Carousel Spin Animation](https://60fps.design/shots/grok-connect-tools-logo-carousel-spin-animation) |
| S1991 | [Grok Tool Connected Pulse Animation](https://60fps.design/shots/grok-tool-connected-pulse-animation) |
| S2017 | [Grok App Connected Pulse Animation](https://60fps.design/shots/grok-app-connected-pulse-animation) |
| S2039 | [ChatGPT Voice Blob Gradient Interaction](https://60fps.design/shots/chatgpt-voice-blob-gradient-interaction) |
| S2041 | [Monogram Keyboard Icon Morph to Chat Input Interaction](https://60fps.design/shots/monogram-keyboard-icon-morph-to-chat-input-interaction) |
| S2042 | [Monogram Rich Chat Response Card Swipe Interaction](https://60fps.design/shots/monogram-rich-chat-response-card-swipe-interaction) |
| S2043 | [Monogram Pulse Sweep Chat Response Reveal Interaction](https://60fps.design/shots/monogram-pulse-sweep-chat-response-reveal-interaction) |
| S2047 | [Monogram Pulse Calendar Connect Reveal Interaction](https://60fps.design/shots/monogram-pulse-calendar-connect-reveal-interaction) |
| S2050 | [Monogram Tap and Hold Mic Liquid Blur Pulse Interaction](https://60fps.design/shots/monogram-tap-and-hold-mic-liquid-blur-pulse-interaction) |
| S2053 | [ChatGPT Model Intensity Slider Interaction](https://60fps.design/shots/chatgpt-model-intensity-slider-interaction) |
| S2055 | [Claude Voice Selection Border Pulse Interaction](https://60fps.design/shots/claude-voice-selection-border-pulse-interaction) |
| S2060 | [District No Internet Connection Empty State Animation](https://60fps.design/shots/district-no-internet-connection-empty-state-animation) |
| S2079 | [Wabi Soothing Loading Fade Reveal Animation](https://60fps.design/shots/wabi-soothing-loading-fade-reveal-animation) |
| S2091 | [Recollect Pro Bottom Sheet to Page Interaction](https://60fps.design/shots/recollect-pro-bottom-sheet-to-page-interaction) |
| S2094 | [Circle Menu Dropdown Morph Interaction](https://60fps.design/shots/circle-menu-dropdown-morph-interaction) |

### 부록 F. 같이 둔 참고 파일

- `docs/research/assets/60fps-2026-11-11-shots-detailed.md` — 이번에 상세를 연 Shots 672건(번호·이름·카테고리·태그·링크)
- `docs/research/assets/60fps-2026-11-11-shots-all.txt` — sitemap의 Shots 전 경로 2,124개(최신순)
- `docs/research/assets/60fps-2026-11-11-video-bursts.md` — 영상 49개의 움직임 버스트 측정값(추정치 원자료)
