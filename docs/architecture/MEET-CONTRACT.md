# Google Meet 참여 (브라우저 봇) 계약

모시가 Google Meet 회의에 **웹 링크로** 들어가서 듣고, 받아 적고, "모시야"라고 부르면 모시 목소리로 대답한다.
전화 다이얼인은 쓰지 않는다(Twilio 체험 계정은 `<Dial>`·`<Stream>`·미인증 번호 발신이 막혀 있다. 조사 결과는 아래 "배경").

```
앱 채팅 ──▶ apps/server (sys_join_meet, 회의 스레드, 호출어 → LLM → 대답, 요약)
                │  HTTP + SSE (127.0.0.1)
                ▼
        services/meet  (Bun + Playwright, 실제 Chrome 한 창)
          ├─ 페이지 주입: getUserMedia → 가상 마이크(WebAudio) ◀── TTS PCM (services/tts /tts/stream)
          ├─ 페이지 주입: RTCPeerConnection 원격 오디오 → 16 kHz PCM ──▶ VAD ──▶ services/stt /stt
          └─ 참여 흐름: 이름 "모시" 입력 → 마이크 켬 → 참여 요청 → 호스트 수락 대기 → 회의 중 → 종료
```

가상 오디오 장치(BlackHole 등)는 설치하지 않는다. 마이크와 회의 소리는 모두 페이지 안 WebAudio로 다룬다.

## 1. services/stt (127.0.0.1:8782, Python, mlx-whisper)

- 모델: `mlx-community/whisper-large-v3-turbo` (이 Mac의 HF 캐시에 이미 있음, 1.5 GB). 측정: 한국어 한 문장 0.31초, 첫 호출 2초.
- `GET /health` → `{ok, ready, model, queue}`
- `POST /stt?lang=ko` 본문 raw s16le 16 kHz mono (`Content-Type: audio/L16; rate=16000`), 최대 30초.
  → `200 {text, ms, durationMs, noSpeech: boolean}`. 400 빈 본문/30초 초과, 503 준비 안 됨.
- 무음 환각 거름: `no_speech_prob`/`avg_logprob` 기준과 알려진 환각 문구("시청해 주셔서 감사합니다", "구독과 좋아요" 등)는
  `text:""`, `noSpeech:true`로 돌려준다.
- 로그에 받아 적은 문장을 남기지 않는다(길이·시간만).

## 2. services/meet (127.0.0.1:8781, Bun + Playwright 1.62.1, `channel: "chrome"`)

127.0.0.1에만 바인딩. 한 번에 회의 하나.

| 메서드 | 경로 | 내용 |
|---|---|---|
| GET | `/health` | `{ok, chrome: "ready"\|"missing", stt: "ready"\|"down", tts: "ready"\|"down", sttEngine: "soniox"\|"local", session: id\|null}` |
| POST | `/sessions` | `{url, name?: "모시", announce?: string, sttPrompt?: string(≤200)}` (sttPrompt는 STT 요청마다 `?prompt=`로 붙인다. 에이전트 이름을 알아듣게 하는 initial prompt) → `201 {id, state}`. url은 `https://meet.google.com/abc-defg-hij` 형식만(400 `invalid_url`). 진행 중인 회의가 있으면 409 `busy`. |
| GET | `/sessions/:id` | `{id, state, reason?, title?, joinedAt?, participants?: number, acks?: string[]}` (acks = `cached:true`로 바로 낼 수 있는 문장) |
| GET | `/sessions/:id/events` | SSE. 아래 이벤트. 연결 시 현재 `state`를 먼저 한 번 보낸다. |
| POST | `/sessions/:id/say` | `{text, cached?: boolean}` (≤600자) → `202 {sayId}`. 순서대로 말한다. `cached:true`는 세션 시작 때 미리 만든 짧은 문장(`MEET_ACK_TEXTS`, 기본 "네,", "네, 잠시만요.", "음,", "네, 듣고 있을게요.", "찾아볼게요.", "잠시만요.")을 TTS·마이크 확인 없이 15 ms 뒤 바로 재생한다(NFC·앞뒤 공백 정리 뒤 문장부호까지 글자 그대로 맞아야 함. GPU TTS로 여섯 개 ≈2.1초에 준비) → `202 {sayId, cached:true}`(루프백 실측 상대 쪽 첫 소리 중앙값 62~91 ms). 캐시에 없는 문장은 일반 TTS로 말하고 `202 {sayId, cached:false}`. 줄 사이는 기다리지 않는다: 앞 줄을 다 예약하면 다음 줄 TTS를 시작하고 앞 줄 끝에 틈 없이 붙인다. `speaking on`은 그 줄 소리가 실제로 시작할 때, 앞 줄 `off` 다음에 온다. 회의 중이 아니면 409. |
| POST | `/sessions/:id/say/stop` | 지금 말하는 것과 대기열을 끊는다(끼어들기). `200` |
| DELETE | `/sessions/:id` | 회의에서 나간다. `200 {state:"ended"}` |

SSE 이벤트:
- `state` `{state, reason?}`
  - `launching` → `prejoin` → `waiting_admission` → `in_call` → `ended`
  - 실패: `denied`(호스트 거절 또는 5분 동안 수락 없음), `blocked`("이 화상 통화에 참여할 수 없습니다" 류),
    `invalid`(코드 없음·회의 종료), `failed`(그 밖), `reason`에 짧은 영어 코드.
    `failed`의 `reason` 중 `network_unavailable`은 회의 페이지를 두 번(사이에 Chrome을 새로 띄워) 열지 못한 경우다(시간 초과·망 오류).
    `goto_failed`는 그 밖의 이유로 페이지를 열지 못한 경우.
- `transcript` `{seq, text, startMs, endMs, speaker: string|null}` 한 발화(VAD로 자른 구간)마다. `speaker`는 Meet 화면에서
  그 순간 말하는 사람으로 표시된 이름(알 수 없으면 null).
- `partial` `{text}` 지금 발화의 아직 확정되지 않은 글자(실시간 STT, 초당 5번 이하). 한 발화의 partial을 다 보낸 뒤 그 발화의
  `transcript`를 보내고, 다음 발화의 partial은 그 뒤에만 보낸다(서버는 partial 다음 첫 transcript를 발화 끝으로 본다).
  서버는 partial에서 호출어를 보면 캐시된 "네,"를 바로 보내고, 대답은 transcript를 받은 뒤에 시작한다. "모시 그만"은 partial에서 바로 멈춘다.
- `endpoint` `{seq, speaker: string|null}` 봇이 한 발화가 끝났다고 정한 순간. `seq`·`speaker`는 뒤따를 그 발화 `transcript`의 값과
  같고(speaker는 발화를 닫을 때 한 번 정한다, 모르면 null), 모든 `transcript` 앞에는 같은 seq의 `endpoint`가 먼저 온다.
  - soniox: 마지막 큰 소리 뒤 `MEET_FINALIZE_SILENCE_MS`(기본 300 ms) 침묵으로 finalize를 보낼 때, 또는 15초 상한에서. 말 끝 →
    endpoint ≈0.35초, endpoint → transcript ≈0.27초. endpoint 뒤 그 transcript까지 `partial` 없음. finalize 없이 닫힌 발화(끊김·자동
    끝점)는 transcript 바로 앞에 온다.
  - local: VAD 구간이 닫힐 때(`MEET_VAD_HANGOVER_MS`, 기본 700 ms) STT 전에. 말 끝 → endpoint ≈0.75초, transcript는 STT 뒤 ≈0.3초.
    local에는 `partial`이 없다.
  - 확정 글자가 없으면(soniox 빈 `<fin>`, local 무음·빈 글자·실패) transcript가 오지 않고 그 seq는 건너뛴다(빈 번호 가능).
  - 대답 쪽: 호출어가 partial에 보인 발화의 endpoint에서 캐시된 "네,"를 친다(soniox: 상대에게 말 끝 ≈0.42초 뒤). local은 호출어를
    transcript에서 판정한다. 대답은 transcript를 받은 뒤 시작한다.
- `speaking` `{on: boolean, sayId}` 모시가 말하기 시작/끝.
- `participants` `{count}` 바뀔 때.
- `ended` `{reason}` (`left`, `kicked`, `meeting_ended`, `alone`(혼자 남은 지 2분), `error`) 후 스트림 종료.

동작 규칙:
- Chrome 프로필: `~/.config/pickle-clone/meet-chrome` (저장소 밖, 0700). 로그인돼 있으면 그 계정으로, 아니면 게스트 "모시"로 참여 요청.
  사용자가 봇 계정에 로그인하려면 `bun services/meet/login.ts`가 같은 프로필로 accounts.google.com 창을 연다(비밀번호는 사용자가 직접 입력,
  코드·로그·LLM 어디에도 닿지 않음).
- 실행 플래그: 자동화 표식 제거(`ignoreDefaultArgs: ["--enable-automation"]`, `--disable-blink-features=AutomationControlled`),
  `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`(주입이 빠져도 실제 카메라·마이크가 절대 열리지 않게. 주입 스크립트도 영상 요청에 합성 카메라만 준다), `--autoplay-policy=no-user-gesture-required`, `--mute-audio`(Mac 스피커로 회의 소리가 나지 않게),
  카메라는 끈 채로 들어간다.
- 마이크: `getUserMedia`의 오디오 트랙을 WebAudio `MediaStreamDestination` 트랙으로 바꾼다. 말할 때만 소리가 실리고 평소엔 무음.
  Meet UI의 마이크 버튼은 켠 상태로 둔다.
- 말하기: `/say`는 services/tts `POST /tts/stream`(44.1 kHz s16le)을 받아 페이지로 흘려 넣는다. 첫 소리 목표 ≤0.5초.
  TTS가 바쁘거나(queue ≥ 2) 꺼져 있으면 `/tts`(mp3/wav) 한 번에 받기로, 그것도 안 되면 `speaking` 없이 실패를 로그로 남긴다.
- 듣기: 원격 오디오 트랙을 모두 섞어 16 kHz mono PCM으로 노드에 넘긴다(Playwright `exposeBinding`, 로컬 WebSocket 금지:
  공개 사이트 → localhost 요청은 Chrome Local Network Access에 막힐 수 있다). 모시가 말하는 동안 들어온 소리도 받아 적는다(자기 소리는 원격 트랙에 없다).
  받아 적기 엔진은 `MEET_STT=soniox|local`(SONIOX_API_KEY가 있으면 soniox).
  - soniox: 회의에 들어갈 때 Soniox WebSocket 하나(stt-rt-v6, 16 kHz s16le, ko strict, 헤더 인증, `context.terms=[이름, 이름+"야"]`,
    `context.text=sttPrompt`)를 열고 소리를 100 ms 묶음으로 계속 보낸다. 확정 토큰으로 발화를 만들고 `<fin>`(자동 끝점을 켜면
    `<end>`도)에서 `transcript`를 낸다. 마지막 큰 소리 뒤 `MEET_FINALIZE_SILENCE_MS`(기본 300) 동안 조용하고 미확정 글자가 있으면
    finalize를 보낸다. 한 발화는 최대 15초. Soniox 자동 끝점은 기본 끔(`MEET_SONIOX_ENDPOINT=1`로 켬: 0.2초 빠르지만 문장 안 짧은
    쉼에서 발화가 조각난다). 미확정 글자는 `partial`로 보낸다. 끊김·408·413·429·5xx는 0.5~8초 간격으로 5번까지 다시 붙고
    (그동안 소리는 10초까지 모아 둠), 400·401·402·403·첫 연결 5초 초과·다시 붙기 실패면 그 세션은 local로 넘어가고
    SSE `log {code:"stt_fallback", reason}`를 보낸다. 키는 Bun 안에서만 쓴다. 루프백 실측: 말 끝 → transcript 0.56~0.58초.
  - local: 에너지 VAD(말 끝 침묵 `MEET_VAD_HANGOVER_MS` 기본 700 ms, 최소 0.4초, 최대 15초)로 잘라 services/stt에 보낸다(≈1.06초).
- 로그: 상태 변화·지연 시간만. 받아 적은 문장, 참석자 이름, 회의 코드 전체를 남기지 않는다(코드는 `abc-****-hij`).

## 3. apps/server

도구 (LLM에 노출):
- `sys_join_meet({url, purpose?})` — **승인 필요**(사용자 이름으로 외부 회의에 들어가는 일). 승인 카드에 회의 코드(가린 형태 아님)와
  "모시가 이 회의에 참여해 듣고 받아 적어요"를 보여 준다. 승인되면 `meet` 스레드("회의 참여", 기존 `call` 스레드와 같은 방식)를 만들고
  services/meet `/sessions`를 부르고, 회의가 끝날 때까지 백그라운드로 SSE를 구독한다(턴과 분리).
- `sys_meet_say({text})` — 진행 중인 회의에서 대신 말하기("회의에서 5분 늦는다고 전해 줘"). 승인 불필요(이미 승인한 회의 안).
- `sys_leave_meet()` — 회의에서 나가기.
- 진행 중인 회의가 없으면 뒤의 두 도구는 숨긴다.

회의 스레드에 남는 것:
- 상태 메시지: 참여 요청 보냄 → 들어감(참여 직후 `announce` 문구를 말한다:
  "안녕하세요, {사용자 이름}님의 AI 비서 모시예요. 회의 내용을 받아 적고 있어요. 저를 부르시려면 '모시야'라고 불러 주세요.")
  → 거절/막힘/종료.
- 받아 적은 내용: 발화 단위로 저장(DB). 스레드에는 1분마다 묶어서 한 메시지로 붙이거나 "회의록" 카드로 보여 준다(앱 작업과 조율).
- 끝나면 요약(결정 사항, 할 일과 담당자, 다음 일정)을 모시가 스레드에 올린다.

포트: services/meet 8781, services/stt 8782 (8791·8792는 앱 QA 서버가 쓰는 관례 포트라 피한다).

회의 대답·요약 모델: `PICKLE_MEET_MODEL`, 기본 `deepseek/deepseek-v4.1-flash-ultrafast`. 3db542b부터 채팅 기본값과 같지만,
회의만 따로 고정할 수 있게 설정은 따로 둔다. 따로 둔 까닭: 예전 채팅 기본값이던 eco 모델은 이 대답 프롬프트에서
첫 토큰이 5~30초라 3초 목표를 못 맞춘다(ultrafast 0.09초, 2026-11-11 측정). 값은 입력 $0.09/M·출력 $0.36/M
(할인 시간대 기준, eco의 3배)이고 대답 한 번에 약 $0.0002. 토큰은 사용자 하루 한도에 더하고, 한도를 넘으면 받아 적기만 계속한다.
회의 스레드는 kind `call`(제목 "회의 참여", 아이콘 people)을 쓴다. 새 kind는 만들지 않는다.

호출어 → 대답 (2026-11-12 실회의 시험 반영):
- whisper는 "모시야"를 "5시야"·"모시자"·"무시아"로 적기도 한다. 정확한 이름은 문장 어디서나 호출, 비슷한 소리 변형은 문장
  맨 앞에서만, 그리고 같은 문장에 뒤따르는 말이 있을 때만 호출로 본다("5시야." 한마디는 시간 대답일 수 있음).
- 호출을 들으면 먼저 `/say {text:"네,", cached:true}`로 바로 맞장구를 치고, 대답을 문장마다 이어 보낸다.

호출어 → 대답:
- 받아 적은 문장에 "모시"(모시야·모시님·모시 씨, whisper 오인식 "모시아" 포함)가 들어가면, 최근 3분 회의록 + 그 문장으로
  LLM 한 번(추론 끔, 말로 하는 대답, 2문장 이내, 마크다운·이모지 금지) → `/say`. 첫 문장이 나오는 대로 말하기 시작.
- 목표: 말이 끝난 뒤 모시 첫 소리까지 ≤3초(침묵 판정 0.7 + STT 0.3 + LLM 첫 문장 ~1.0 + TTS 0.25 + 네트워크).
- 모시가 말하는 중에 누가 "모시 그만"/"잠깐"이라고 하면 `/say/stop`.
- 회의록·대답 생성에 쓰는 LLM은 기존 OpenGateway 모델. 사용자 비밀값·전화번호는 들어가지 않는다.

회의 중 도구 호출 (`apps/server/src/meetAgent.ts` `runMeetTurn`, 2026-11-12):
- 채팅과 같은 에이전트 러너(`createRunTurn`)를 `PICKLE_MEET_MODEL` 클라이언트(추론 끔, `deps.llm.meetClient`)로 돌린다.
  대화 기록 없이 회의 전용 시스템 프롬프트를 쓰고, 사용자 메시지에는 "지금"(시각·인원·부른 사람·연결된 메신저)과 최근 3분 회의록을 넣는다.
  말은 해요체로 한다. 도구 없이는 2문장, 도구를 쓰면 3문장까지.
- 도구: 모든 `k_*`, `sys_time`, `sys_recall`(기억 켬일 때), `sys_schedule_list`, `sys_web_fetch`, `sys_create_artifact`, `msg_connections`,
  `msg_list_chats`, `msg_read`, 이 회의만 읽는 `sys_meet_notes`(다른 회의 목록은 빼고 준다).
  `msg_send`·`sys_phone_call`·`sys_call_me`·`sys_friend_message`·`sys_schedule_create/delete`는 실행하지 않는다. 대신 회의 참여 스레드에
  보통 승인 카드(approvals 행, llm `[]`)만 올린다. 승인하면 그 스레드에서 일반 채팅 턴이 이어서 실행한다.
  카드는 주인이나 1:1 회의일 때만, 한 턴에 하나만 올린다. `sys_join_meet`·`sys_leave_meet`·`sys_meet_say`·`sys_remember`와 그 밖의 도구는 아예 주지 않는다.
- 개인 정보: 메신저 내용·예약 작업·기억은 인원이 2명 이하(봇 포함)이거나 부른 사람이 주인일 때만 소리 내어 말한다.
  주인 판정은 이름 퍼지 매칭으로 한다("이하늘" ↔ "하늘"). 인원을 모르면 단체 회의로 본다.
  그 밖에는 도구를 실행하되 고정 문장 한 줄("개인 정보라서 …회의 참여 대화방에 올려 둘게요.")만 말하고, 모델이 쓴 내용은 스레드에만 올린다.
  말하는 문장은 모두 전화번호·이메일·카드번호·토큰을 가리고(`speechSafe`), URL·마크다운을 뺀다.
- 지연: 첫 도구 호출이 시작될 때 도구를 실행하기 전에 `onFiller`를 한 번 부른다(이미 한 문장을 말했으면 부르지 않는다).
  meet.ts는 이때 캐시된 맞장구를 튼다. 독립된 도구는 병렬로 실행한다. 도구 하나는 8초, 턴 전체는 15초에서 끊고, 끊기면 짧은 대체 문장을 말한다.
  끼어들기(`signal`)가 오면 큐에 남은 문장까지 버린다.
- 자세한 내용: 모델이 말하는 문장 뒤에 `[앱]` 줄과 마크다운(뉴스 링크, 메시지 요약, 목록)을 쓰면 그 부분은 말하지 않고 회의 참여 스레드에
  assistant 메시지로 올린다. 만든 문서 카드(artifact)와 로그인 카드도 같이 올린다. 날씨·검색 결과 카드는 올리지 않는다.
- 도구를 부르지 않고 "확인 카드를 올렸어요"라고 말하는 모델 오류는 막는다. 그 문장은 카드가 실제로 생길 때까지 붙잡아 두고,
  끝까지 카드가 없으면 "그건 회의 중에는 바로 할 수 없어요. 회의가 끝나고 앱에서 부탁해 주세요."로 바꿔 말한다.
- 사용량은 채팅 턴과 같이 계산한다(캐시된 프롬프트는 10%, 하루 한도 초과면 호출하지 않음). 로그에는 시간·도구 이름·개수·결과만 남긴다.
- 실측(2026-11-12 02:30 KST, deepseek-v4.1-flash-ultrafast, 19개 질문 × 2회): `k_*` 맞장구 중앙값 0.42초(20번 중 19번 ≤0.8초),
  첫 문장 중앙값 1.03초(20번 중 19번 ≤3초, 넘은 1번은 k_gov_support 업스트림 2.95초). 도구 없는 대답의 첫 문장은 0.2~0.4초.
- 멈춘 턴과 대체된 턴:
  - 멈춘 턴은 이미 한 일을 예전처럼 올린다. 끼어들기, 새 호출, "모시 그만", 양보(아래 D), 듣기만 하기, 나가기로 `signal`이 멈추면 말은
    그친다. 그래도 만든 문서 카드, 승인 카드, 다 써 둔 `[앱]` 내용은 올린다. `[앱]` 내용이 다 써 있는 경우는 대답을 다 만든 뒤 말하는
    중에 멈춘 경우다. 쓰다 만 `[앱]`은 예전에도 지금도 올리지 않는다.
  - 대체된 턴은 아무것도 올리지 않는다. 말 이어 감(아래 C)으로 멈춘 턴이 여기에 해당하고, abort 사유는 `SupersededTurn`이다. 합친
    말로 턴을 다시 돌리므로, 올리면 두 번 올라간다. 승인 카드 대역은 카드를 올리기 직전에 대체됐는지 한 번 더 본다.
  - 바깥에 남는 일을 하는 도구(`sys_create_artifact`, 승인 카드 대역)가 시작되면 `onCommit`을 부른다. 그 뒤로 meet.ts는 그 대답을 C로
    대체하지 않는다. 그래서 대체된 턴에는 바깥에 남은 일이 없다.

말 차례 지키기 (2026-11-14, `apps/server/src/meet.ts`; B의 `turnIncomplete`는 `packages/protocol/src/turn.ts`):
- **A. 나가 달라는 말.** 이름(정확한 이름, 또는 문장 맨 앞의 비슷한 소리)과 나가라는 명령이 함께 있으면 나간다: "모시야 이제 나가도 돼",
  "모시 나가 줘", "모시야 회의에서 나가", "모시야 이만 가 봐", "모시 퇴장해", "모시야 먼저 나가 있어". 누구든 부탁할 수 있다.
  - 나가는 말이 아닌 것: 부르는 말이 없는 "모시가 나가면 회의록은 누가 써?", 물음 "모시 나가는 거 아니지?", "안 나가도 돼", "나가지 마",
    말하는 사람이 나가는 "저 먼저 나가 볼게요", "-봐야"("저는 3시에 나가 봐야 해서요", "이제 가 봐야 할 시간이야"). "이제 됐어 / 조용히 해 /
    들어가 있어"는 예전처럼 듣기만 하기(dismiss)다.
  - 대화 모드에서는 이름 없는 말도 된다. 말에 나가라는 명령(`isLeaveRequest`)이 있고, 받는 사람 판정이 `other`(참석자끼리 하는 말)가
    아니면 나간다. 이런 말은 대개 `dismiss`로 판정된다. 로그는 `meet addressee {verdict: "leave", classified}`다. 판정에 `leave`를 따로
    두지 않는다. 넣어 보니 나가는 일에 대한 물음("너 나가는 거 아니지?")이 `addressed`에서 빠졌다(SERVER-CONTRACT.md의 실측).
  - 하는 일: 기다리던 말 차례를 버리고, 만들던 대답을 멈추고, 말하던 소리를 끊는다(`/say/stop`). 그다음 "네, 이만 나갈게요. 회의록은 앱에
    정리해 둘게요."를 보통 TTS로 말한다(회의록에 모시가 한 말로 남는다). 그 sayId가 `speaking` on→off 될 때까지(최대 8초) 기다린 뒤
    `sys_leave_meet`와 같은 길(`DELETE /sessions/:id`)로 나간다. 끝 사유는 `asked`(봇이 보내는 `ended {reason:"left"}`도 `asked`로 기록),
    스레드 문구는 "회의에서 나가 달라는 말을 듣고 나왔어요."이고 요약은 평소처럼 올린다.
  - in_call일 때만 한다. 모델이 필요 없어서 모델 없이도 되고, 인사말 TTS가 실패해도 그대로 나간다. 나가는 동안 들은 말은 받아 적기만 한다.
    그 호출의 endpoint에서는 "네,"를 먼저 하지 않는다. 규칙에 안 맞아 모델에게 간 나가 달라는 부탁에는 "모시야, 이제 나가도 돼"처럼
    이름을 불러 말해 달라고 안내한다.
- **B. 말이 끝날 때까지 기다리기.** `turnIncomplete(text)`(`packages/protocol/src/turn.ts`, 앱 음성 통화가 덜 끝난 말을 기다릴 때도
  같은 규칙을 쓴다)는 마지막 낱말만 보는 한국어 규칙이다. 연결 어미(-고, -는데/-은데/-ㄴ데, -서,
  -면/-으면, -면서, -지만, -거나, -든지, -니까), 매달린 조사(를/을, 이/가, 은/는, 에/에서, 의, 로/으로, 랑/하고/와/과, 도, 만),
  군말·부사(그, 저, 음, 어, 좀, 혹시, 그리고, 근데, 그래서, 그러니까), 쉼표나 "…"로 끝나면 덜 끝난 말이다. 물음표로 끝나면 끝난 말이다
  ("그럼 내일은?"). 조사처럼 보이는 명사("광고", "결과", "회의", "보고서", "주가", "차이")와 "-ㄴ가" 물음은 끝난 말로 본다. 끝에 붙은
  호출("근데 모시야")은 빼고 본다. 덜 끝났다고 잘못 보면 한 번 기다리고, 끝났다고 잘못 보면 일찍 답한다(그때는 C가 받친다).
  - 모시에게 한 말(내용 있는 호출, 이름만 부른 뒤의 질문, `addressed`로 판정된 이어 말)이 덜 끝났으면 바로 답하지 않고 말 차례
    (`PendingTurn`, 예전 HeldCall을 넓힌 것)로 붙잡는다. 호출이면 "네,"를 먼저 하고(이미 했으면 그대로), 이어 말이면 소리 없이 기다린다.
  - 마지막 말소리(partial·endpoint·transcript 어느 것이든) 뒤 `MEET_TURN_HOLD_MS`(기본 1500 ms)를 기다린다. 같은 사람의 다음 transcript는
    이어 붙여 다시 판단하고, 끝난 말이 되면 바로 답한다. 어느 한쪽에 이름이 없으면 같은 사람으로 본다. 다른 이름의 사람 말은 붙이지도,
    따로 판정하지도 않고 대답만 늦춘다(한 번에 대답 하나). 조용해지면 그때까지 들은 말로 답하고, 처음 붙잡은 때부터 10초(`turnMaxMs`)가
    상한이다. 이어 말 차례는 끝났을 때 전체가 질문·부탁이 아니면 진술로 보고 답하지 않는다(`gate: "statement"`).
  - 이름만 부른 경우는 예전처럼 `callFollowMs`(4초) 뒤 "말씀하세요."지만, 이제 마지막 말소리부터 잰다.
  - 끝난 말은 예전과 똑같이 바로 답한다. 가짜 봇에서 같은 프로브로 79856c8과 비교했다(50회씩 두 번, transcript → 첫 `/say` 중앙값):
    호출 0.3 → 0.2~0.3 ms, partial 없는 호출 0.3 → 0.3 ms, 이어 말 0.7 → 0.5~0.7 ms, 에이전트 대답 0.3~0.4 → 0.4 ms.
- **C. 대답이 시작된 뒤 말을 이어 갈 때.** 대답을 시작한 뒤 첫 진짜 문장(맞장구·필러는 빼고)을 보내기 전에 맞장구가 아닌 3음절 이상의
  partial이 오면, 대답을 버리고("네,"는 그대로 둔다) 들은 말을 다시 말 차례로 붙잡아 다음 transcript와 B 규칙으로 합친다. 로그
  `meet turn continued {on, syllables}`. 버린 대답은 대체된 턴이라 아무것도 올리지 않는다(위). 바깥에 남는 일을 하는 도구가 시작된
  대답과, 처음 붙잡은 때부터 10초가 지난 대답은 버리지 않는다.
- **D. 남의 말 위에 말하지 않기.**
  - 양보: 모시가 대답 문장을 말하는 동안 맞장구가 아닌 음절이 `MEET_YIELD_SYLLABLES`(기본 6, 0이면 끔)에 이르는 partial이 오면 말을
    멈추고(`/say/stop`) 남은 대답을 버린다. 멈춘 턴이라 만든 문서 카드 같은 것은 그대로 올린다(위). 로그 `meet yield {on, syllables}`.
    그 말은 평소대로 흘러간다(대화 모드면 받는 사람 판정).
    "네네", "아 그렇구나", "네 맞아요", "진짜요", "고마워요" 같은 맞장구·반응은 세지 않는다.
  - 겹쳐 시작하지 않기: 600 ms 안에 partial이 왔고 아직 endpoint가 없으면(누가 말하는 중) 모시의 첫 문장("말씀하세요." 포함)은 그
    endpoint를 기다린다(최대 3초). 캐시된 맞장구("네," 등)는 기다리지 않는다. 기다린 시간은 `meet reply`의 `waitMs`.
- 로컬 STT(partial 없음)에서는 C와 D가 transcript로만 동작한다. 첫 문장 전에 온 transcript가 C, 대답을 말하는 중에 온 transcript가 D다.
  겹쳐 시작하지 않기는 기다릴 partial이 없어서 동작하지 않는다.
- 로그에는 사유·개수·ms만 남긴다: `meet turn held {kind, bare}`, `meet turn {kind, end: complete|hold|cap, parts, waitMs}`,
  `meet turn continued`, `meet yield`, `meet leave asked {how, said, played, ms}`. 말 내용과 이름은 남기지 않는다.
- 환경 변수: `MEET_TURN_HOLD_MS`(0~10000, 기본 1500, 0이면 기다리지 않음), `MEET_YIELD_SYLLABLES`(0~100 정수, 기본 6, 0이면 양보 끔).

## 4. 시험

- 구글 없이: 로컬 HTML 페이지에서 RTCPeerConnection 두 개를 이어(loopback) 주입 스크립트를 그대로 검증한다.
  `/say`로 넣은 TTS 소리가 상대 쪽 원격 트랙으로 나오고, 그 소리를 캡처→STT 했을 때 원문과 같은지.
- 실제 Meet: 사용자가 만든 시험 회의(meet.new)에서만. 사용자의 실제 업무 회의에는 참여 요청을 보내지 않는다.

## 배경 (2026-11-11 조사)

- Twilio 체험 계정: `<Dial><Number>`, `<Stream>` 막힘, 인바운드도 인증 번호만. 무료 가상번호를 중계로 쓸 수 없다.
- Telnyx·SignalWire·Plivo·Vonage 체험도 인증 번호로만 발신. Meet dial-out은 Workspace 같은 도메인 + 지원 국가(한국 없음).
- 유료로 가장 견고한 길은 Twilio 업그레이드($20 + 번호 월 $1.15) 후 다이얼인 + Media Streams. 지금은 하지 않는다.
- Google 약관은 서비스를 방해하는 자동 접근을 금지한다. 회의 참석자에게 봇임을 밝히는 안내(`announce`)를 기본으로 켠다.
