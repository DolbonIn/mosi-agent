# services/meet — 모시의 Google Meet 참여 봇

모시가 Google Meet 회의에 웹 링크로 들어가 회의 소리를 받아 적고, 부르면 모시 목소리로 대답하게 해 주는 로컬 서비스예요.
실제 Chrome 창 하나를 Playwright로 띄워서 참여 전 화면의 이름 칸·마이크·참여 버튼을 사람처럼 다룹니다. 소리는 모두
페이지 안의 WebAudio로 처리해서 BlackHole 같은 가상 오디오 장치는 필요 없어요. 계약은
[`docs/architecture/MEET-CONTRACT.md`](../../docs/architecture/MEET-CONTRACT.md) §2입니다.

```
apps/server ──HTTP+SSE──▶ services/meet (127.0.0.1:8781, Bun + Playwright, Chrome 한 창)
                            ├─ 가상 마이크: getUserMedia → WebAudio 트랙 ◀── services/tts /tts/stream (44.1 kHz)
                            └─ 회의 소리: RTCPeerConnection 원격 트랙 → 16 kHz PCM → VAD → services/stt /stt
```

## 실행

필요한 것: macOS의 Google Chrome, Bun, 저장소 루트에 설치된 Playwright 1.62.1(`playwright install`은 하지 않아요.
`channel: "chrome"`으로 이미 설치된 Chrome을 씁니다), 그리고 services/tts(:8790)와 services/stt(:8782).

```sh
services/meet/start.sh            # http://127.0.0.1:8781
bun services/meet/login.ts        # (선택) 봇 Google 계정에 로그인
```

| 환경 변수 | 기본값 | 뜻 |
|---|---|---|
| `MEET_PORT` | `8781` | 이 서비스 포트(127.0.0.1에만 바인딩) |
| `MEET_STT_URL` | `http://127.0.0.1:8782` | services/stt |
| `MEET_TTS_URL` | `http://127.0.0.1:8790` | services/tts |
| `MEET_TTS_VOICE` | (TTS 기본) | TTS 목소리 id |
| `MEET_PROFILE_DIR` | `~/.config/pickle-clone/meet-chrome` | Chrome 프로필(0700으로 만듦) |
| `MEET_GOTO_COMMIT_TIMEOUT_MS` | `8000` | 회의 페이지 열기: 서버 응답(commit)까지. 외부 연결이 안 되는 Chrome은 여기서 실패한다 |
| `MEET_GOTO_TIMEOUT_MS` | `20000` | 회의 페이지 열기: 한 번 시도의 DOM까지 전체 제한(두 번 시도) |
| `MEET_ADMISSION_TIMEOUT_MS` | `300000` | 호스트 수락 대기(넘으면 `denied`/`admission_timeout`) |
| `MEET_ALONE_TIMEOUT_MS` | `120000` | 혼자 남으면 나가기까지 |
| `MEET_NO_JOIN=1` | | 점검용: 이름·마이크·카메라까지만 하고 참여 버튼은 누르지 않음(`prejoin`에 머묾) |
| `MEET_HEADLESS=1` | | 창 없이(시험용. 실제 회의는 창을 띄우는 쪽이 덜 막힘) |
| `MEET_TEST_LOOPBACK=1` | | 시험 전용: `{url:"http://127.0.0.1:…", test:"loopback"}`을 받고 `/sessions/:id/debug`를 연다. 운영에서 켜지 마세요 |
| `MEET_FORCE_SCRIPT_PROCESSOR=1` | | 시험용: AudioWorklet 대신 ScriptProcessor 대체 경로로 캡처 |
| `MEET_WARM_TTS=1` | | 시험 루프백에서도 TTS 데우기(실제 회의에서는 항상 함) |
| `MEET_STT` | 키가 있으면 `soniox`, 없으면 `local` | 받아 적기: `soniox`(실시간 WebSocket) 또는 `local`(services/stt). soniox가 5초 안에 못 붙거나 치명 오류(400·401·402·403, 다시 붙기 5번 실패)면 그 세션은 local로 넘어가고 SSE `log {code:"stt_fallback", reason}` |
| `SONIOX_API_KEY` | | Soniox 키. `start.sh`가 `~/.config/pickle-clone/secrets.env`를 `--env-file`로 읽는다. Bun 프로세스 안에서 헤더로만 쓰고 로그·페이지·응답에 넣지 않음 |
| `MEET_FINALIZE_SILENCE_MS` | `300` | soniox: 말이 이만큼 멈추면 `finalize`를 보내 발화를 바로 닫는다(0.3초 넘는 쉼에서 발화가 나뉨) |
| `MEET_SONIOX_ENDPOINT=1` | (끔) | soniox 자동 끝점(`<end>`)도 쓰기. 켜면 자연스러운 말에서 0.2초쯤 빨라지지만, 문장 안 0.1초 쉼에서도 발화가 낱말 단위로 조각난 적이 있어 기본은 끔 |
| `MEET_VAD_HANGOVER_MS` | `700` | 말 끝 침묵 판정(200~2000). 500이면 말 끝 → `transcript`가 0.2초 빨라지고, 0.5초 넘는 쉼에서 구간이 나뉨(아래 측정) |
| `MEET_ACK_TEXTS` | `네,\|네, 잠시만요.\|음,\|네, 듣고 있을게요.\|찾아볼게요.\|잠시만요.` | 세션 시작 때 TTS로 한 번 만들어 두는 맞장구·짧은 대답 문장(`\|`로 구분, 빈 값이면 만들지 않음). 대화 모드의 물러나는 대답("네, 듣고 있을게요."), 도구 쓰는 동안 채우는 말("찾아볼게요."), 대답이 늦을 때 채우는 말("잠시만요.")도 여기서 `/say {cached:true}`로 쓴다. 한 문장은 잘라 낸 뒤 4초 이하여야 한다 |

API(요약, 자세한 것은 계약 문서):

```sh
curl -s localhost:8781/health
curl -s -XPOST localhost:8781/sessions -d '{"url":"https://meet.google.com/abc-defg-hij","name":"모시","announce":"안녕하세요, 모시예요."}'
curl -sN localhost:8781/sessions/<id>/events          # SSE: state, transcript, partial, endpoint, speaking, participants, log, ended
curl -s -XPOST localhost:8781/sessions/<id>/say -d '{"text":"5분 늦는다고 하셨어요."}'
curl -s -XPOST localhost:8781/sessions/<id>/say -d '{"text":"네, 잠시만요.","cached":true}'   # 맞장구: TTS 없이 바로
curl -s -XPOST localhost:8781/sessions/<id>/say/stop
curl -s -XDELETE localhost:8781/sessions/<id>
```

- 오류는 `{error}`: 400 `invalid_url`·`bad_json`·`empty_text`·`too_long`, 404 `not_found`, 409 `busy`·`not_in_call`.
- `POST /sessions`의 `sttPrompt`(≤200자): local STT 요청마다 `?prompt=`로 붙이고(빈 문자열이면 `?prompt=`로 STT 기본 문장 끄기),
  soniox에서는 `context.text`로 넣는다. soniox `context.terms`에는 `name`과 `name+"야"`가 들어간다. 로그에 남기지 않는다.
- `/say {text, cached:true}`: 미리 만들어 둔 맞장구 소리를 TTS를 부르지 않고 바로 낸다 → `202 {sayId, cached:true}`.
  캐시에 없는 문장이면 일반 TTS로 말한다 → `202 {sayId, cached:false}`. 만들어 둔 문장은 `GET /sessions/:id`의 `acks`.
- SSE `partial {text}`(soniox만): 지금 발화의 확정+미확정 전체 글자, 초당 5번 이하. 한 발화의 partial을 다 보낸 뒤 그 발화의
  `transcript`가 오고, 다음 발화의 partial은 그 뒤에만 온다(예약돼 있던 partial은 발화가 닫히면 버린다).
- SSE `endpoint {seq, speaker}`: 발화 끝을 정한 순간. `seq`·`speaker`는 뒤따를 그 발화 `transcript`의 값과 같다(모든 transcript 앞에
  같은 seq의 endpoint가 온다. `speaker`는 모르면 `null`).
  - soniox: 마지막 큰 소리 뒤 `MEET_FINALIZE_SILENCE_MS` 침묵으로 `finalize`를 보낼 때, 또는 15초 상한. endpoint와 그 transcript 사이에는
    partial이 오지 않는다. finalize 없이 닫힌 발화(연결 끊김, 자동 끝점)는 transcript 바로 앞에 endpoint가 온다. 말 끝 → endpoint 0.35초.
  - local: VAD 구간이 닫힐 때(말 끝 뒤 `MEET_VAD_HANGOVER_MS` 700ms, STT 전). transcript는 STT 뒤(0.3초 안팎)에 온다. local 길은 partial이 없다.
    말 끝 → endpoint 0.76초.
  - 확정 글자가 없으면(soniox 빈 `<fin>`, local STT 무음 판정·빈 글자·실패) endpoint 뒤에 transcript가 없다(그 seq는 건너뜀).
  - 대답 쪽은 호출어가 보인 발화의 endpoint에서 캐시된 "네,"를 치면 된다(soniox는 말 끝 0.35초 뒤).
- SSE `log {code, reason}`: 지금은 `stt_fallback`(soniox → local, reason은 `connect_timeout`·`soniox_401`·`reconnect_failed` 같은 코드)만.
  맞장구 바로 뒤에 보낸 `/say {text}`는 맞장구가 나가는 동안 TTS를 시작하고, 소리는 맞장구 끝에 틈 없이 붙어요.
- 실패로 끝나면(`denied`·`blocked`·`invalid`·`failed`) `state` 다음에 `ended {reason:"error", state}`가 오고 스트림이 닫혀요.
- 회의 페이지 열기(goto)는 두 번 시도해요. 한 번은 서버 응답(commit) 8초, DOM까지 20초 제한이고, 실패하면 Chrome을 닫고(아래 5초 상한)
  다시 띄워 한 번 더 엽니다. 두 번 다 시간 초과나 망 오류(`net::ERR_CONNECTION_*`·`ERR_NAME_*`·`ERR_INTERNET_*`·`ERR_TIMED_OUT` …)면
  `failed`/`network_unavailable`, 그 밖이면 `failed`/`goto_failed`. 로그는
  `goto_failed name=TimeoutError net=ERR_… stage=commit|load attempt=n/2 ms=… launchMs=… cookies=ok/3ms|timeout|error`만 남기고 URL·회의 코드·쿠키는
  남기지 않아요. `cookies`는 실패 직후 `ctx.cookies()`가 2초 안에 오는지예요. Chrome 쿠키 저장소는 macOS Keychain 키로 풀리므로(봇은
  `--use-mock-keychain`을 빼고 띄워요) `timeout`이면 Keychain(secd) 멈춤 쪽, `ok`면 망 단절 쪽으로 봅니다(쿠키가 있는 봇 프로필에서 의미가 있어요).
  (2026-11-12 18:26~18:39Z, 이 Mac에서 새로 띄운 Chrome이 외부 TCP에 붙지 못한 13분이 있었고, 그동안 secd가 100~285% CPU였다가 secd가
  다시 뜬 18:39Z에 풀렸어요.)
- Chrome 닫기는 5초까지만 기다려요. `ctx.close()`가 넘기면 우리가 띄운 Chrome 프로세스 그룹(이 프로세스의 자식, 이 프로필)을 SIGKILL하고
  `teardown forced`를 남겨요. 다음 세션은 앞 Chrome이 다 닫힐 때까지 기다렸다가 띄웁니다(같은 프로필이라 `profile_in_use` 방지).
- `transcript.startMs`/`endMs`는 epoch ms(절대 시각)예요. `seq`는 세션마다 1부터 셉니다.
- `announce`를 주면 회의에 들어간 직후 그 문장을 말해요(`speaking` 이벤트의 `sayId`는 서버가 붙인 값).
- SSE에 다시 붙을 때 `?since=<마지막으로 받은 seq>`를 주면 그 뒤의 `transcript`를 상태 다음에 다시 보내요(세션마다 최근 2000개).

## 참여 흐름

`launching` → `prejoin` → (`waiting_admission`) → `in_call` → `ended`

1. 프로필로 Chrome을 띄우고 회의 링크를 엽니다. 주입 스크립트가 페이지보다 먼저 들어가 `getUserMedia`·`enumerateDevices`·
   `RTCPeerConnection`을 감쌉니다.
2. 참여 전 화면: "Google 계정으로 로그인" 말풍선을 닫고, 이름 칸이 있으면 이름을 한 글자씩 치고, 카메라를 끄고 마이크를 켠 뒤
   `지금 참여`(바로 들어감) 또는 `참여 요청`(수락 필요)을 누릅니다.
3. 수락 대기: 나가기 버튼(`call_end`)이 보이면 `in_call`. "참여 요청이 거부됨"류는 `denied`, "이 화상 통화에 참여할 수 없습니다"류는
   `blocked`, 회의 코드 오류·이미 끝난 회의는 `invalid`, 5분 동안 수락이 없으면 `denied`(`admission_timeout`).
4. 회의 중: 1초마다 화면을 봅니다. 내보내짐 → `ended`(`kicked`), 회의 종료 → `meeting_ended`, 참석자가 나뿐이고 2분 동안 아무도 말하지
   않음 → 나가기 버튼을 누르고 `alone`. 말하기 직전에는 Meet 마이크가 켜져 있는지 다시 확인해요.
5. `DELETE`: 나가기 버튼을 누르고 Chrome을 닫습니다(`left`).

선택자는 클래스 이름 대신 `aria-label`·`role`·`data-is-muted`·버튼 문구를 쓰고 한국어·영어를 함께 둡니다(`selectors.ts`). 다른 언어
UI에서는 아이콘 글꼴 문구(`mic`, `videocam`, `call_end`)로 찾고, 나가기 버튼을 못 찾으면 참석자 타일로 회의 안인지 판단해요.

### 게스트 vs 로그인

| | 게스트(기본) | 봇 계정 로그인 |
|---|---|---|
| 이름 | 참여 전 화면에 "모시"를 입력 | 계정 이름으로 표시(이름 칸 없음) |
| 들어가기 | 항상 `참여 요청` → 호스트가 수락해야 함 | 같은 조직이거나 초대받았으면 `지금 참여`로 바로 |
| 막힐 가능성 | 높음: 회사(Workspace) 회의는 외부 게스트를 막는 경우가 많고, Google이 자동화 브라우저 게스트를 거절하기도 함(`blocked`) | 낮음 |
| 준비 | 없음 | `bun services/meet/login.ts`로 한 번 로그인 |

`login.ts`는 자동화 없이 그냥 Chrome을 같은 프로필로 띄워 accounts.google.com을 엽니다(Playwright로 열면 Google이 "안전하지 않은
브라우저"로 로그인을 막는 일이 있어요). 비밀번호는 사용자가 그 창에 직접 입력하고, 코드·로그·모시 서버·LLM은 그 값을 보지 않아요.
개인 계정 말고 모시 전용 계정을 쓰세요. services/meet가 회의 중이면 프로필이 잠겨 있어 로그인 창이 열리지 않습니다.

## 소리 처리

- **가상 마이크**: Meet가 `getUserMedia`를 부르면 실제 마이크 대신 WebAudio `MediaStreamDestination` 트랙(44.1 kHz 컨텍스트, 요청마다
  복제본)을 돌려줍니다. `deviceId` 조건은 무시하고, 트랙의 `label`·`getSettings().deviceId`·`applyConstraints`를 가상 장치에 맞춰 둡니다.
  `enumerateDevices`에는 가상 입력(모시 마이크·모시 카메라)만 보이고 출력 장치는 이름만 중립적으로 바꿔요.
  평소엔 무음이고 `/say`일 때만 소리가 실립니다.
- **영상**: 영상을 요청해도 실제 카메라 대신 "모시"라고 쓴 캔버스 트랙을 주고, 참여 전에 카메라를 꺼 둡니다.
- **말하기**: `/say` → TTS `/tts/stream`을 받는 대로(50 ms 이상 모이면) 페이지로 넘겨 `AudioBufferSourceNode`로 끊김 없이 이어 붙여요.
  첫 묶음은 60 ms 뒤에 시작하고, 말하는 도중 TTS가 늦어 바닥나면 250 ms를 모아 두고 다시 시작해 더 끊기지 않게 합니다.
  줄 사이는 기다리지 않아요: 한 줄의 소리를 다 예약하면 그 줄이 재생되는 동안 다음 줄의 TTS를 시작하고, 다음 줄은 앞 줄이 끝나는
  시각에 바로 붙습니다. `speaking on`은 그 줄의 소리가 실제로 시작할 때, `off`는 그 줄이 끝날 때 와요(앞 줄 off → 다음 줄 on 순서).
- **맞장구(ack)**: 세션 시작 때 TTS 데우기 바로 다음에 `MEET_ACK_TEXTS`의 문장들을 한 번씩 TTS로 만들어 앞뒤 무음을 잘라 메모리에
  두고(서비스 프로세스 전체에서 하나, 다음 회의에서는 다시 만들지 않음), 회의 페이지 가상 마이크에도 미리 올려 둡니다.
  기본 여섯 문장은 GPU TTS(8794 어댑터)에서 차례로 만들어 모두 약 2.1초(앞 다섯 개 1.78초 + "잠시만요." 0.34초 따로 실측, 한 문장 0.28~0.43초,
  잘라 낸 길이 0.36~1.66초, 2026-11-12)이고,
  다 만들어지기 전의 `cached:true`는 일반 TTS로 말해요(`202 {cached:false}`). 문장은 NFC·앞뒤 공백 정리 뒤 글자 그대로 맞아야 캐시를 씁니다.
  `/say {cached:true}`는 마이크 확인·TTS 상태 확인을 기다리지 않고 key만 페이지로 보내 15 ms 뒤에 재생해요. TTS가 바쁘면(`queue` > 0)
  20초까지 기다렸다가 그래도 바쁘면 만들지 않고 넘어갑니다(그 회의에서 `cached:true`는 일반 TTS로 말함).
  TTS `queue ≥ 2`이거나 스트림이 첫 소리 전에 실패하면 `/tts` wav를 한 번에 받아 재생하고, 그것도 안 되면 `speaking` 없이 로그만 남겨요.
  `/say/stop`은 TTS 요청을 끊고(abort) 페이지에 예약된 소리를 15 ms 페이드아웃 후 멈춥니다.
- **듣기**: `RTCPeerConnection`의 `track` 이벤트로 원격 오디오 트랙을 모두 받아 섞습니다. Chrome에서는 원격 WebRTC 트랙을 미디어 요소에
  붙여야 WebAudio로 샘플이 흐르므로 음소거한 `Audio` 요소에 붙여 둬요. 48 kHz → 16 kHz 다운샘플(창 함수 sinc, 7.2 kHz에서 자름)은
  AudioWorklet에서 하고, 안 되면 ScriptProcessor로 대신합니다. 100 ms 묶음을 Playwright `exposeBinding`으로 Node에 넘겨요
  (로컬 WebSocket은 Chrome Local Network Access에 막힐 수 있어 쓰지 않음). `--mute-audio`로 Mac 스피커에는 회의 소리가 나지 않지만
  캡처는 그대로 됩니다(시험으로 확인).
- **실시간 STT(soniox)**: 회의에 들어가는 순간 Soniox WebSocket(`wss://stt-rt.soniox.com/transcribe-websocket`, 헤더
  `Authorization: Bearer`, `stt-rt-v6`, 16 kHz s16le, `language_hints:["ko"]` strict, 맥락 `domain=회의`)을 하나 열고, 회의 소리를
  100 ms 묶음 그대로 계속 보냅니다(연결 전·다시 붙는 중에는 10초까지 모아 뒀다 보냄). 확정 토큰을 모아 `<fin>`에서 `transcript`를 냅니다
  (`<end>`·`<fin>`은 글자에서 뺌, 토큰 시각 → epoch ms). 아래 에너지 VAD로 마지막 큰 소리 뒤 `MEET_FINALIZE_SILENCE_MS`가 지났고
  미확정 글자가 있으면 `finalize`를 보냅니다(잡음 때문에 침묵이 안 잡혀도 15초에서 닫음). 소리를 15초 못 보내면 `keepalive`.
  500·503·408·413·429와 끊김은 0.5·1·2·4·8초 간격으로 다시 붙고(413은 바로), 400·401·402·403은 바로 local로 넘어갑니다.
  나갈 때는 빈 텍스트 프레임 → `{finished:true}`(최대 2초) → 남은 확정 글자를 `transcript`로.
- **VAD**: 20 ms 프레임 에너지. 문턱 = max(−45 dBFS, 최근 4초 가장 조용한 프레임 + 10 dB). 말 끝 침묵 700 ms(`MEET_VAD_HANGOVER_MS`), 최소 0.4초,
  최대 15초(넘으면 끊고 이어서), 앞 200 ms·뒤 300 ms 여유. 구간마다 services/stt에 보내고(503이면 한 번 재시도),
  `noSpeech`이거나 빈 글자면 버립니다.
- **말한 사람(`speaker`)**: 최선 노력이에요. 말하는 동안 0.4초마다 참석자 타일(`[data-participant-id]`)의 클래스 변화를 보고, 정확히 한
  타일만 움직일 때 그 이름(`.notranslate`)을 모읍니다. 실제 회의에서 아직 검증하지 않았고, 모르면 `null`이에요.
  발화를 닫을 때(soniox: finalize, local: VAD 구간 끝) 가장 많이 모인 이름 하나로 정해 `endpoint`와 `transcript`에 같이 싣습니다.
  다음 발화는 시작하자마자 한 번 묻고, soniox에서는 finalize 뒤 VAD hangover 동안은 묻지 않아 앞 사람이 다음 발화로 넘어가지 않게 해요.

## 시험

```sh
bun test services/meet/test                                     # 단위 46개, 브라우저 없음
bun --env-file=$HOME/.config/pickle-clone/secrets.env services/meet/test/loopback.e2e.ts --fixed-wav   # Soniox로 끝까지
bun services/meet/test/loopback.e2e.ts                     # 구글 없이 끝까지(AudioWorklet)
bun services/meet/test/loopback.e2e.ts --script-processor --fixed-wav
```

- 단위: VAD 구간 자르기(합성 PCM), URL 검사, 상태 기계, SSE 형식, 리샘플러(페이지에 들어가는 바로 그 파일), WAV, Listener(가짜 STT),
  SayQueue(가짜 TTS: 스트림·바쁨·실패·꺼짐·끼어들기), 맞장구 캐시(무음 자르기, 한 번만 만들기, TTS 바쁘면 건너뛰기),
  맞장구 + 대답 이어 말하기(TTS 0회, 대답 TTS가 맞장구 재생 중에 시작, 틈 0, speaking 순서, 끼어들기), hangover 500/700,
  Soniox(가짜 WS 서버: 인증 헤더·설정, partial → transcript 순서, `<end>`/`<fin>` 빼기, 토큰 시각, finalize·`<fin>` 지연, 빈 텍스트 프레임으로 끝내기,
  partial 초당 5번, 503 다시 붙기, 401 치명, 핸드셰이크 무응답 → connect_timeout, keepalive, 300 ms 침묵에서 finalize, 15초 강제 finalize,
  401 → local로 넘어감), HTTP API(가짜 세션: sttPrompt, cached 없으면 TTS).
- 루프백 E2E: 로컬 페이지에서 `RTCPeerConnection` 두 개를 잇고, A의 마이크는 주입한 `getUserMedia`, B의 원격 트랙은 주입한 캡처 훅으로
  받습니다. 실제 HTTP로 `/sessions` → `/say` → SSE `transcript`를 받아 원문과 비교하고, 맞장구(`cached`) 5번의 상대 쪽 첫 소리,
  맞장구 + 대답의 틈·순서·받아 적기, 마디 사이 쉼(`MEET_E2E_PAUSES`, 기본 450/600 ms)에서 구간 나뉨과 낱말 잘림, `/say/stop` 뒤 상대 쪽이
  조용해지는지 봅니다. 받는 쪽 지터 버퍼 지연과 두 오디오 시계의 밀림도 결과 JSON에 남겨요.
  `--fixed-wav`(또는 TTS가 바쁠 때)는 미리 만든 wav를 실제 TTS처럼 0.25초 뒤부터 흘려 주는 가짜 TTS를 써요(맞장구 문장에는 그 wav의
  첫 마디를 줌).
  `MEET_E2E_DIR`(시험 프로필·캐시 위치), `MEET_E2E_DUMP=1`(STT로 보낸 구간을 그 디렉터리에 wav로 저장).
- 실제 Meet: `MEET_NO_JOIN=1`로 참여 전 화면까지만 점검할 수 있어요. 실제 참여는 사용자가 만든 시험 회의에서만 합니다.

### 측정 (M3 Max, 2026-11-12, 다른 작업과 GPU를 같이 쓰는 상태)

| 항목 | 값 |
|---|---|
| `/say` → 상대 쪽 첫 캡처, TTS 첫 소리 0.25초 고정(가짜 TTS) | AudioWorklet 398 ms, ScriptProcessor 453 ms |
| 이 서비스가 더하는 지연(TTS 첫 묶음 도착 → 상대 쪽 캡처) | 약 130~200 ms (헬스 확인, 60 ms 여유, WebRTC) |
| 실제 TTS 첫 묶음(`/tts/stream`, 한 문장) | 데워져 있을 때 0.6~0.85초. 한동안 안 쓰면 8~70초(아래 "TTS 데우기") |
| STT 왕복(5초 구간) | 0.25~0.38초 (STT가 다른 요청을 처리 중이면 10초까지 늘어난 적 있음) |
| 말 끝 → `transcript` | 약 1.1초 (침묵 판정 0.7 + STT 0.38) |
| 받아 적기 | 원문 "안녕하세요, 모시예요. 오늘 회의 내용을 받아 적고 있어요." → "안녕하세요 모시에요. 오늘 회의 내용을 받아 적고 있어요." (CER 0.043) |
| `/say/stop` → 페이지에서 멈춤 / `speaking off` | 2 ms / 0~2 ms. 상대 쪽 마지막 소리는 멈춘 뒤 0.33초 안(WebRTC 꼬리) |
| `/say {cached:true}` → 상대 쪽 첫 캡처 (TTS 0회) | 중앙값 62~73 ms, 15번 중 최대 86 ms (HTTP 응답 0~1 ms) |
| 맞장구(0.87초) + 대답: 대답 TTS 요청 / 줄 사이 틈 | 맞장구 요청 뒤 3~6 ms에 시작 / 0 ms (페이지 예약 기준) |
| 말 끝 → `transcript`에서 STT를 뺀 몫 | hangover 700: 0.74~0.75초, 500: 0.53~0.55초 |
| 마디 사이 쉼 450·600 ms인 문장 | 700: 한 구간, 500: 600 ms 쉼에서 두 구간. 둘 다 낱말 잘림 없음(CER 0.043, "예요"→"에요"만) |
| 참여 전 화면 도착 / 이름·마이크·카메라 처리 | 약 2~3.4초 / 1.5초 |

### Soniox 측정 (루프백, 실제 Soniox, 2026-11-12, 자동 끝점 끔)

| 항목 | macOS Yuna "모시야, 오늘 회의에서 정한 일정 다시 정리해 줄래?" (3.7초) | 모시 TTS "안녕하세요, 모시예요. 오늘 회의 내용을 받아 적고 있어요." (4.5초) |
|---|---|---|
| 연결(첫 토큰 전) | 0.5~0.8초 (회의 들어갈 때 한 번) | 같음 |
| 호출어가 보인 시각 | partial에서, 말 시작 1.40초 뒤 = 말 끝나기 2.28초 전 | 말 시작 2.2초 뒤(첫 발화 transcript) |
| 말 끝 → `endpoint` | 0.35초 | |
| 말 끝 → `transcript` | 0.58~0.64초 (finalize → `<fin>` 0.24~0.36초) | 0.56초 |
| 말 끝 → 캐시된 "네," 상대 쪽 첫 소리(endpoint 받자마자 보냄) | 0.42초 | |
| 말 끝 → 캐시된 "네," 상대 쪽 첫 소리(transcript 받자마자 보냄) | 0.66초 | 0.64초 |
| 발화 나뉨 | 한 발화, CER 0 | 0.36초 쉼에서 두 발화, CER 0 |
| 자동 끝점을 켜면(`MEET_SONIOX_ENDPOINT=1`) | 말 끝 → transcript 0.34~0.37초 | 낱말 단위 다섯 조각("오늘 회의." "내용을." …, 3/3번) |

local(whisper)은 같은 시험에서 말 끝 → `endpoint` 0.76초(VAD 구간 끝), 말 끝 → transcript 1.04~1.06초(침묵 판정 0.7 + STT 0.3)입니다.
루프백에서 받는 쪽 WebRTC 지터 버퍼가 실행 20~40초쯤부터 0.7~0.9초로 부푼 적이 여러 번 있어(목표 1.1~2.0초, 시스템 스왑 중), 그때는
상대 쪽 첫 소리 값이 그만큼 늘어납니다(맞장구 0.08초 → 0.3초). 실제 회의에서도 확인하도록 10초마다 받는 쪽 지터 버퍼를 재서 0.3초를 넘으면
로그에 남기고 `/debug`의 `stats.rx`에 둡니다.

### TTS 데우기

이 Mac은 스왑을 24 GB 가까이 쓰고 있어서(2026-11-12), 한동안 쉰 TTS는 가중치가 스왑으로 밀려나 있어요(그때 TTS 프로세스 RSS 52 MB).
그 상태에서 첫 `/tts/stream`은 첫 묶음까지 8~70초가 걸렸고(5번 측정: 71, 38, 30, 12, 8초), 바로 다음 요청은 0.8초였습니다. 그래서
세션을 시작할 때(Chrome을 띄우는 동안) TTS가 한가하면(`queue` 0) "네." 한 줄을 요청해 첫 묶음만 받고 끊어요. 참여 요청·수락을 기다리는
동안 가중치가 올라오므로 `announce`와 첫 대답이 덜 늦습니다. TTS가 실시간보다 느리게 나오면 말 중간에 소리가 바닥나는데(underrun),
그때는 250 ms를 모아 두고 이어서 끊김을 줄입니다. 쉼이 침묵 판정(기본 0.7초)을 넘으면 받아 적는 쪽에서는 구간이 둘로 나뉘어요.

## 한계

- **봇 차단**: 참여 전 화면에 "봇이 아닌 실제 사용자인지 확인하기 위해 시스템 정보가 전송됩니다"라고 나옵니다. 자동화 표식은
  지웠지만(`navigator.webdriver` false, 감싼 함수도 `[native code]`로 보임) Google이 게스트 참여를 거절할 수 있고, 그러면 `blocked`예요.
  로그인한 봇 계정이 더 잘 들어갑니다. 실제 참여는 아직 시험 회의에서 확인하지 않았어요.
- **Meet 화면이 바뀌면** 선택자가 깨질 수 있어요. 참여 전 화면(한국어·영어)은 실제 페이지에서 확인했고, 회의 중·대기·거절·종료 화면의
  문구와 나가기 버튼·참석자 수·말한 사람은 공개 자료와 추정으로 만든 것이라 실제 회의에서 확인이 필요합니다.
- 녹화 동의 같은 대화 상자가 참여를 가로막으면 처리하지 못합니다.
- 한 번에 회의 하나. 같은 프로필을 쓰므로 `login.ts`와 동시에 쓸 수 없어요(`failed`/`profile_in_use`).
- TTS·STT가 같은 GPU를 쓰는 공용 서비스라, 다른 작업과 겹치면 첫 소리와 받아 적기가 몇 초씩 늦어질 수 있어요.
- Meet의 소음 제거가 켜져 있으면 모시 목소리도 조금 다듬어질 수 있어요.

## Google 약관

Google 서비스 약관은 서비스를 방해하거나 정해진 방법 밖으로 자동 접근하는 것을 금지합니다. 이 봇은 사용자가 승인한 회의에만,
사람 한 명처럼 한 창으로 들어가고, 들어가자마자 `announce`로 AI 비서임을 밝히는 것을 기본으로 합니다. 그래도 계정 제한이나 참여 거절이
생길 수 있고, 그 위험은 이 기능을 켜는 쪽이 집니다. 사용자의 실제 업무 회의에서 시험하지 마세요.

## 개인정보

- 실제 마이크와 카메라는 열지 않습니다. 주입 스크립트가 가상 장치를 주고, 혹시 주입이 빠져도 `--use-fake-device-for-media-stream`
  때문에 Chrome의 가짜 장치만 열려요. Mac 스피커로 회의 소리가 나지 않습니다(`--mute-audio`).
- 로그에는 상태 변화와 지연 시간, 글자 수만 남아요. 받아 적은 문장, 참석자 이름, 회의 코드 전체(`abc-****-hij`로 가림)는 남기지 않습니다.
- 소리와 받아 적은 글은 디스크에 저장하지 않고 SSE로 apps/server에만 넘깁니다(저장은 apps/server의 몫).
- Chrome 프로필(쿠키, 로그인 상태)은 `~/.config/pickle-clone/meet-chrome`(0700)에 있고 저장소 밖이에요. 로그아웃하려면 `login.ts`로
  열어서 로그아웃하거나 그 디렉터리를 지우세요.
