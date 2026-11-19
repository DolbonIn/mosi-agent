# 모시

개인 AI 에이전트 앱 "모시"입니다. 피클(Pickle) 같은 개인 AI 에이전트 앱에서 영감을 받아
서버, 에이전트, 모바일 앱(PWA)을 처음부터 새로 썼습니다. 사용자마다 이름 붙인
에이전트(기본 "깽이")가 대화하고, 날씨·지하철·뉴스·정부 지원사업 같은 한국 생활 도구를 쓰고, 예약 작업과
브리핑을 돌리고, 승인을 받은 뒤 메시지 전송이나 전화를 대신합니다. 친구와 대화방을 같이 쓸 수도 있습니다.

내부 식별자(`@pickle/*` 패키지, `PICKLE_*` 환경 변수, 폴더·DB 이름, TTS 목소리 id `pickle`)는 개발 초기 이름을
그대로 씁니다.

공개본 안내:
- `services/tts/voices/`의 목소리 샘플은 Fish Audio Drama-3로 만든 합성 음성입니다. Drama-3 가중치는 Fish Audio Community
  License(연구·비상업 용도 중심)를 따르니, 상업적으로 쓰기 전에 라이선스를 확인하세요.
- `services/tts-remote`의 GPU 서버 이름(`gpu-host`)과 경로(`/mnt/shared/mosi-tts`)는 예시 값입니다.
- 비밀값은 저장소에 없습니다. `.env.example`을 참고해 직접 채워 주세요.

## 구성

```
apps/server         Bun.serve + bun:sqlite API 서버. 인증, 대화·SSE 턴 스트리밍, 기기 서명 승인,
                    자격 증명 엔클레이브, 메신저 연결, 예약·브리핑, 친구 대화, 전화(Twilio), 일일 사용량 한도
apps/mobile         Vite + React 19 PWA. Liquid Glass 화면, 스프링 모션(framer-motion), r3f 배경
packages/protocol   서버와 앱이 같이 쓰는 와이어 타입
packages/agent      OpenGateway LLM 클라이언트(스트리밍, 도구 호출), 에이전트 루프, 시스템 도구, 기억 추출
packages/launcher   사용자별 에이전트 작업 공간(페르소나, USER.md, 마크다운 기억, 스킬)과 실행 lease
packages/vault      자격 증명 엔클레이브: 기기에서 봉인한 봉투, 사용자별 키(DEK) 암호화, 접근 기록, 승인 서명 검증
packages/skills     k-skill 도구 21종(호스팅 프록시 경유, 키 없음)
packages/messengers agent-messenger 연결: 카카오톡, 슬랙, 디스코드, 텔레그램, LINE, 인스타그램, Teams 등
services/tts        로컬 한국어 TTS(Fish Audio Drama-3, MLX 4-bit). 127.0.0.1:8790, 전화 음성용
qa/                 실서버 e2e 시나리오
docs/               서버 계약, 패키지 API, 모션 스펙, QA 결과
```

자세한 계약은 [`docs/architecture/SERVER-CONTRACT.md`](docs/architecture/SERVER-CONTRACT.md)(앱이 알아야 할 서버 동작),
[`docs/architecture/PACKAGES.md`](docs/architecture/PACKAGES.md)(패키지 API), [`docs/design/MOTION-SPEC.md`](docs/design/MOTION-SPEC.md)(화면·모션)에 있습니다.

## 준비물

- Bun 1.4 이상
- ffmpeg: TTS 음성 인코딩
- cloudflared(선택): 전화 음성 파일을 Twilio가 받을 수 있게 공개 터널을 엽니다
- Apple Silicon Mac(TTS만 해당): 처음 설치 때 모델 약 22 GB를 내려받고, 실행 중 통합 메모리 약 28 GB를 씁니다. Python 3.12와 `uv`가 필요합니다.
- 모바일 브라우저 QA: 설치된 Google Chrome과 Playwright WebKit(루트의 `playwright` 1.62.1)

## 비밀값과 환경 변수

비밀값은 저장소 밖 `~/.config/pickle-clone/secrets.env`에 두고, 커밋하거나 로그·채팅에 남기지 않습니다.
아래는 변수 **이름**입니다.

| 변수 | 용도 |
|---|---|
| `OPENGATEWAY_API_KEY` | LLM 키. 없으면 서버는 뜨지만 대화는 503 |
| `OPENGATEWAY_BASE_URL`, `OPENGATEWAY_MODEL` | LLM 주소와 모델(기본 `deepseek/deepseek-v4.1-flash-ultrafast`. 2026-11-12 사용자 결정: eco는 첫 응답 24~40초로 느려져 같은 모델의 ultrafast 요금제로 바꿈, 약 3배 비용) |
| `VAULT_MASTER_KEY` | 자격 증명 암호화 마스터 키(32바이트, base64) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | 전화. `TWILIO_FROM`을 비우면 계정 번호를 자동으로 찾습니다 |
| `PICKLE_TURN_THINKING` | 대화 턴의 숨은 추론. 기본은 끔(첫 응답이 빨라짐), `on`이면 제공자 기본값 |
| `PICKLE_TTS_URL`, `PICKLE_AUDIO_PORT`, `PICKLE_PUBLIC_AUDIO_URL`, `PICKLE_AUDIO_TUNNEL` | 모시 음성(TTS) 설정. [`services/tts/README.md`](services/tts/README.md) 참고 |

비밀이 아닌 서버 설정: `PORT`(기본 8787), `HOST`(기본 127.0.0.1), `PICKLE_DATA_DIR`(기본 `<repo>/.data`),
`PICKLE_DAILY_TOKENS`(하루 토큰 한도), `PUBLIC_ORIGIN`, `TRUST_PROXY`, `KSKILL_PROXY_BASE_URL`.

보안 원칙: LLM은 비밀번호, 토큰, API 키를 보지 않습니다. 로그인 정보는 기기에서 엔클레이브 공개키로 봉인해 보내고,
서버는 사용자별 키로 다시 암호화해 둡니다. 밖으로 나가는 행동(메시지 전송, 전화)은 기기 키로 서명한 승인을 받은 뒤에만 합니다.

## 실행

```bash
bun install

# 서버(실제 LLM, secrets.env 사용) → http://127.0.0.1:8787
bun run server:live

# 모바일 개발 서버 → http://localhost:5173 (/api는 서버로 프록시)
bun run dev
PICKLE_API=http://127.0.0.1:8799 bun run dev   # 다른 포트의 서버를 쓸 때

# 로컬 TTS (Apple Silicon)
services/tts/setup.sh   # 처음 한 번: 가상환경과 모델 내려받기
services/tts/start.sh   # 127.0.0.1:8790에서 실행
```

데이터는 `PICKLE_DATA_DIR`에 쌓입니다. 시험할 때는 `PICKLE_DATA_DIR=$(mktemp -d)`처럼 임시 폴더를 쓰면 됩니다.
배포용 빌드는 `bun run build`(결과물 `apps/mobile/dist`)입니다.

## 테스트와 QA

```bash
bun run test                               # packages + apps/server 단위·통합 테스트 (키가 필요한 라이브 테스트는 건너뜀)
bunx tsc --noEmit -p apps/server           # 서버 타입 검사
bun run typecheck                          # 모바일 타입 검사
bun test ./apps/mobile/qa/*.test.ts        # 모바일 단위 테스트

# 실서버 e2e: 실제 LLM, k-skill, 자격 증명 봉인, 기기 서명 승인, 멈춤, 친구 초대 (23단계)
PICKLE_URL=http://127.0.0.1:8787 bun qa/e2e-api.ts

# 모바일 브라우저 QA (390×844, Chrome + WebKit, 라이트/다크/모션 줄이기)
node apps/mobile/qa/foundation.spec.mjs    # 먼저 bun run build
node apps/mobile/qa/chat.spec.mjs          # 실서버 필요(QA_API, 기본 :8791)
node apps/mobile/qa/more.spec.mjs          # 실서버 필요(QA_API, 기본 :8792)
```

`bun test apps/mobile/qa`처럼 폴더째 돌리면 브라우저 시나리오(`*.spec.mjs`)까지 실행되니 위처럼 파일을 지정하세요.
브라우저 QA의 스크린샷과 결과는 `docs/qa/`에 남습니다.

## 알려진 한계

- **Twilio 체험 계정**: 인증해 둔 번호로만 전화가 걸립니다(그 밖의 번호는 오류 573002). 인라인 TwiML을 받지 않아 Twilio Echo twimlet URL로 대신 보냅니다. Google Meet 같은 회의 전화 참여는 유료 계정이 필요합니다.
- **카카오톡**: 실제 계정으로는 시험하지 않았고, 가짜 계정으로 오류 처리만 확인했습니다. 아이디·비밀번호 로그인은 공식 API가 아니어서 약관 위반이나 계정 제한 위험이 있으니 본인 계정에서만 위험을 알고 쓰세요.
- **k-skill 장애**: 호스팅 프록시 쪽 문제로 쇼핑(`k_shopping`), 미세먼지(`k_fine_dust`), 주유소 가격(`k_gas_prices`), 주식 시세(`k_stock`)가 자주 실패합니다(2026-11-11 기준). 일부 도구는 지역이 제한됩니다.
- **Drama-3 가중치 라이선스**: Fish Audio Community License 1.0입니다. 연구·비상업 용도는 무료이고, 상업 용도는 연 매출 50만 달러 미만일 때만 허용됩니다. TTS 자체를 남에게 서비스로 제공하려면 별도 계약이 필요하고, 쓰는 제품에는 "Built with Fish Audio"를 표시해야 합니다. 가중치는 저장소에 없고 `services/tts/setup.sh`가 내려받습니다.
- **숨은 추론 끔**: 첫 응답 속도를 위해 대화 턴은 추론 없이 돌립니다. 어려운 다단계 요청에서 답이 약하면 `PICKLE_TURN_THINKING=on`으로 켜세요.
