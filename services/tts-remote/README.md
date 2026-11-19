# services/tts-remote — 원격 GPU 서버에서 도는 모시 목소리 (Fish Audio Drama-3)

Mac의 `services/tts`(MLX 4-bit, :8790)는 메모리 압박을 받으면 모델이 디스크로 밀려나서 첫 소리까지 3~70초가 걸린다.
여기서는 같은 Drama-3 모델(FP8 원본)을 원격 GPU 서버의 GPU 한 장에 올려 두고, Mac에는 **`services/tts`와 똑같은 HTTP API**를
127.0.0.1:8794로 연다. `apps/server`와 `services/meet`는 URL만 바꾸면 된다.

```
apps/server, services/meet
   │  http://127.0.0.1:8794   (services/tts와 같은 API: /health, /tts, /tts/stream)
   ▼
services/tts-remote/server.py  ← Mac, 파이썬 표준 라이브러리만 씀 (start.sh)
   │  http://127.0.0.1:8795   (vLLM-Omni OpenAI 음성 API)
   ▼
SSH 터널 (tunnel.sh, 끊기면 다시 붙음)
   │
   ▼
GPU 서버 gpu-host  127.0.0.1:8796 ── docker 컨테이너 `mosi-tts-b` (vLLM-Omni 0.32.0, GPU 5)
```

## 무엇이 어디서 도나

| 위치 | 이름 | 포트 | 내용 |
|---|---|---|---|
| GPU 서버 | docker 컨테이너 `mosi-tts-b` (이미지 `mosi-tts:vllm-omni-0.32.0`) | 127.0.0.1:8796 (서버 루프백에만 publish) | `vllm serve fishaudio/drama-3 --omni`, **GPU 5 한 장**, VRAM 약 62 GB (엔진 57 GB + 코덱 5 GB), `--restart unless-stopped`, `--stage-init-timeout 1200 --init-timeout 1800`. 2026-11-12에 GPU 4의 `mosi-tts`(:8795)에서 blue/green으로 옮겼다(아래 "엔진 교체") |
| GPU 서버 | `~/mosi-tts/` | — | `Dockerfile`, `mosi-drama3.yaml`, `run-engine.sh`, `voices/`, `cache/`(torch.compile·업로드한 목소리, 약 300 MB) |
| GPU 서버 | `/mnt/shared/mosi-tts/hf` | — | 가중치 41.5 GB (NFS). `/`에는 이미지 레이어 약 1 GB만 더했다 |
| Mac | screen `mosi-tts-tunnel` (`tunnel.sh`, `up.sh`가 띄움) | 127.0.0.1:8795 | `ssh -N -L 127.0.0.1:8795:127.0.0.1:8796 gpu-host`, 끊기면 1~30초 뒤 다시 연결. Mac 쪽 8795는 어느 엔진 슬롯이 돌든 그대로다 |
| Mac | screen `mosi-tts-remote` (`start.sh`) | 127.0.0.1:8794 | 어댑터. 로그와 pid 파일은 `~/Library/Logs/mosi-tts-remote/` |
| Mac | launchd 에이전트 `com.mosi.tts-remote` (`watchdog.sh`, `launchd/`) | — | **준비만 해 두었고 설치하지 않았다**(공용 Mac에 남는 변경이라 사용자 승인이 필요). 설치하면 15초마다 터널·어댑터를 보고 죽은 것만 다시 띄운다 |

GPU 0~3은 다른 작업용으로 비워 둔다. `run-engine.sh`는 0~3을 거부하고, 고른 GPU에 다른 프로세스가 있거나 2 GB 넘게 쓰이고 있으면
시작하지 않는다.

### 어댑터를 Mac에 둔 이유

- 터널이나 엔진이 죽으면 어댑터가 `/health`에 `ready:false`, 요청에 503 `loading`을 돌려준다. 지금 `services/tts`가 로딩 중일
  때와 같은 응답이라 `apps/server`·`services/meet`의 대체 경로(Web Speech, Twilio `<Say>`, `/tts` wav)가 그대로 동작한다.
  어댑터를 GPU 서버에 두면 터널이 끊겼을 때 Mac에서는 그냥 연결 거부만 보인다.
- mp3 변환(ffmpeg, loudnorm −16 LUFS)을 Mac에서 지금과 똑같이 한다.
- GPU 서버(공용 장비)에는 컨테이너 하나만 둔다. 어댑터는 표준 라이브러리만 쓰므로 venv가 필요 없다.

## 시작과 정지

### Mac

```sh
services/tts-remote/up.sh      # 터널(screen mosi-tts-tunnel)과 어댑터(screen mosi-tts-remote)를 띄우고 /health를 보여 줌
services/tts-remote/down.sh    # 둘 다 정지 (pid 파일로만 끔, 다른 프로세스는 건드리지 않음)
curl -s localhost:8794/health  # ready:true 이면 준비 끝
```

로그와 pid 파일은 `~/Library/Logs/mosi-tts-remote/`(`TTS_RUN_DIR`)에 있다. 터미널에서 직접 `./tunnel.sh`, `./start.sh`로
띄워도 된다.

**지금 쓰는 방식과 감시 체계 (2026-11-12)**

- 터널과 어댑터는 `up.sh`로 띄운 detached screen 세션이다. SCREEN이 launchd(ppid 1) 밑의 새 세션이라 띄운 터미널이나
  Claude 세션이 끝나도 계속 돈다.
- 터널: `tunnel.sh`가 ssh가 끝날 때마다 다시 붙인다. 오래 붙어 있었으면 1초 뒤, 계속 실패하면 최대 30초 간격이다.
  keepalive(15초 × 3)로 죽은 연결을 약 45초 안에 알아챈다. 직접 끊어 보니 2.6초 만에 복구됐다.
- 어댑터: 엔진에 요청마다 새로 연결하므로 따로 붙일 연결이 없다. 2초마다 엔진 상태를 보고, 터널이 돌아오면 다시 `ready`가
  된다.
- **프로세스가 죽거나 Mac을 재시작했을 때는 지금 아무것도 다시 띄우지 않는다.** `up.sh`를 손으로 돌려야 한다. 자동으로
  되살리는 launchd 감시자를 `launchd/`에 준비해 두었지만, 공용 Mac에 남는 변경이라 사용자 승인 전에는 설치하지 않는다.
  (2026-11-12 02:27에 잠깐 설치했다가 보류 지시를 받고 몇 분 뒤 `launchctl bootout`으로 지웠다. 지금 `launchctl`에는 아무것도 없다.)

**launchd 감시자 (준비만 됨, 설치 안 함)**

- `launchd/com.mosi.tts-remote.plist`: 틀. `install.sh`가 `@...@` 자리를 채운다. 로그인할 때 시작하고, 감시자가 죽으면
  launchd가 다시 띄운다(`KeepAlive`). `AbandonProcessGroup`이라 감시자를 내려도 터널·어댑터는 계속 돈다.
- `watchdog.sh`: 15초마다 pid 파일과 명령줄(`tunnel.sh`/`server.py`가 들어 있는지)로 터널·어댑터가 살아 있는지 보고, 없는
  것만 `up.sh`와 같은 screen 세션으로 띄운다. 살아 있는 pid는 재시작하지도 끄지도 않는다.
- macOS는 launchd 에이전트가 `~/Documents`를 읽지 못하게 막는다("Operation not permitted"). 그래서 `install.sh`가
  `server.py`, `start.sh`, `tunnel.sh`, `watchdog.sh`와 목소리를 `~/Library/Application Support/mosi-tts-remote/`에 복사하고,
  에이전트는 그 사본을 쓴다. 이 파일들을 바꾸면 `install.sh`를 다시 돌려야 감시자가 새로 띄울 때 반영된다.
- 시험(launchctl에 아무것도 올리지 않고 `watchdog.sh`를 다른 포트로 한 번 직접 돌림): 비어 있는 시험 인스턴스의 터널과
  어댑터를 1초 안에 띄웠고, 시험 어댑터를 죽이니 15초 안에 그것만 다시 띄웠다. 라이브 pid는 그대로였다.

```sh
services/tts-remote/launchd/install.sh --print   # 쓸 plist를 보여 주기만 함 (아무것도 바꾸지 않음)
services/tts-remote/launchd/install.sh           # 설치 — 사용자 승인 뒤에만
services/tts-remote/launchd/uninstall.sh         # 제거 (터널·어댑터는 계속 돎)
launchctl print gui/$(id -u)/com.mosi.tts-remote | grep -E 'state|pid'   # 설치했다면 상태
```

설치한 뒤 완전히 끄려면 `uninstall.sh`를 먼저 돌리고 그다음 `down.sh`를 돌린다. 순서를 바꾸면 감시자가 15초 안에 다시
띄운다. 어댑터나 터널을 바꿔야 할 때는 살아 있는 것을 끄지 말고 다른 포트로 두 번째 인스턴스를 띄워 확인한 뒤 바꾼다.
예: `TTS_RUN_DIR=$HOME/Library/Logs/mosi-tts-remote-b TTS_PORT=18794 TTS_ENGINE_PORT=18795 TTS_ENGINE=127.0.0.1:18795 TTS_SCREEN_PREFIX=mosi-tts-b ./up.sh`
(끌 때도 같은 `TTS_RUN_DIR`로 `down.sh`). Mac의 8797·8798은 다른 프로그램(bun)이 쓰고 있어서 18794·18795를 쓴다.

`apps/server`·`services/meet`를 GPU 쪽으로 돌리기:

```sh
PICKLE_TTS_URL=http://127.0.0.1:8794   # apps/server
MEET_TTS_URL=http://127.0.0.1:8794     # services/meet
```

2026-11-12부터 사용자 미리보기 앱 서버(`PICKLE_TTS_URL`)와 Meet 봇(`MEET_TTS_URL`)이 :8794를 쓴다. Mac `services/tts`(:8790)는
스왑이 32/32 GB에 차서 꺼 두었다. 되돌리려면 `services/tts/start.sh`로 다시 띄우고 URL을 `http://127.0.0.1:8790`으로 돌린다.

환경 변수(어댑터): `TTS_PORT`(8794), `TTS_HOST`(127.0.0.1), `TTS_ENGINE`(127.0.0.1:8795), `TTS_ENGINE_KIND`(vllm, SGLang-Omni
엔진이면 `sglang`), `TTS_VOICE_DIR`(../tts/voices), `TTS_SLOTS`(12, sglang이면 11), `TTS_SILENCE_CUT_S`(1.2),
`TTS_LEAD_CUT_S`(1.5), `TTS_SILENT_PEAK`(300), `TTS_PYTHON`(python3), `TTS_PROBE_TIMEOUT_S`(5), `TTS_PROBE_FAILS`(3).
sglang 모드 전용: `TTS_WARM_BURSTS`(4,8,12,16, 빈 값이면 끔, 1보다 작은 크기는 버림), `TTS_WARM_LEVELS`(2,4,8,12,16, 규칙은 같음),
`TTS_WARM_LEVEL_S`(14), `TTS_REWARM_AFTER_S`(60). 아래 "SGLang-Omni 엔진"의 "워밍업 묶음"과 "엔진 상태 확인"을 볼 것.
터널: `TTS_SSH_HOST`(gpu-host), `TTS_ENGINE_PORT`(8795, Mac 쪽), `MOSI_TTS_PORT`(8796, 서버 쪽 = 지금 도는 엔진 슬롯 B).

어댑터 로그 줄에는 시각이 붙고, 503 `loading`을 줄 때마다 한 줄(`503 loading (/tts/stream): ...`)을 남긴다. 텍스트는
남기지 않는다. 이 두 가지는 2026-11-12 엔진 교체 뒤에 넣어서, 지금 도는 어댑터(pid 81300)는 다음에 다시 띄울 때부터 적용된다.

### GPU 서버

```sh
services/tts-remote/gpu/deploy.sh            # Mac에서: gpu/ 파일과 voices를 ~/mosi-tts로 복사하고 mosi-tts-b 시작
                                             # (GPU 5, :8796. 이미 돌고 있으면 거부. 바꾸려면 아래 "엔진 교체")
ssh gpu-host 'docker logs -f mosi-tts-b'     # 진행 상황
ssh gpu-host 'docker stop mosi-tts-b'        # 정지 (GPU 메모리 바로 반환). 다시 켜기: docker start mosi-tts-b
ssh gpu-host 'docker rm -f mosi-tts-b'       # 완전히 지우기 (재부팅해도 다시 안 뜸)
ssh gpu-host 'nvidia-smi -i 5'               # VRAM 확인
```

- 시작부터 준비까지 **약 5~12분**: 가중치 읽기 25~50초(NFS, 약 0.8 GB/s), torch.compile 약 70초, CUDA 그래프 캡처 약
  110초, 그 밖의 워밍업. 첫 시작 때는 단계 초기화 제한(기본 300초)에 걸려 컨테이너가 한 번 재시작됐다. 그래서
  `run-engine.sh`는 `--stage-init-timeout 1200 --init-timeout 1800`을 주고, 지금 도는 `mosi-tts-b`에는 이 옵션이 들어가 있다.
  `mosi-tts-b`는 torch.compile 캐시가 데워진 상태에서 재시작 없이 5분 42초 만에 준비됐다(stage 0 초기화 130초).
- 엔진이 뜬 직후 첫 요청은 약 5초 걸린다. 어댑터가 엔진이 (다시) 보일 때마다 목소리를 올리고 목소리마다 한 줄씩 미리
  만들어서 이 비용을 대신 낸다(로그의 `warm-up`).
- 컨테이너는 `--restart unless-stopped`라서 엔진이 죽거나 서버가 재부팅되면 docker가 다시 띄운다.

### 엔진 교체 (blue/green) — 쓰는 중인 엔진을 먼저 끄지 말 것

엔진은 다시 뜨는 데 5~12분 걸리고, 그동안 :8794는 503이다(Mac `services/tts`는 꺼 둔 상태라 목소리가 아예 없어진다). 그래서
`run-engine.sh`는 돌고 있는 컨테이너를 같은 이름으로 바꾸려 하면 거부한다(`MOSI_TTS_REPLACE=1`일 때만 바꿈). 슬롯은 둘이고
번갈아 쓴다.

| 슬롯 | 컨테이너 | GPU | 서버 포트 | 상태 (2026-11-12) |
|---|---|---|---|---|
| A | `mosi-tts` | 4 | 8795 | 비어 있음 (교체 뒤 지움) |
| B | `mosi-tts-b` | 5 | 8796 | **라이브**. `run-engine.sh`·`deploy.sh`·`tunnel.sh`의 기본값 |

설정이나 버전을 바꿀 때는 아래 순서를 따른다. 예시는 B가 라이브일 때 A로 옮기는 경우다.

1. 비어 있는 슬롯에 새 엔진을 띄운다: `MOSI_TTS_NAME=mosi-tts MOSI_TTS_GPU=4 MOSI_TTS_PORT=8795 services/tts-remote/gpu/deploy.sh`.
   그 직전에 `ssh gpu-host nvidia-smi -i 4`로 GPU가 비어 있는지 본다(`run-engine.sh`도 비어 있지 않으면 시작하지 않는다).
2. 두 번째 터널과 어댑터로 확인한다:
   `TTS_RUN_DIR=$HOME/Library/Logs/mosi-tts-remote-b TTS_PORT=18794 TTS_ENGINE=127.0.0.1:18795 TTS_ENGINE_PORT=18795 MOSI_TTS_PORT=8795 TTS_SCREEN_PREFIX=mosi-tts-b services/tts-remote/up.sh`
   `curl -s localhost:18794/health`가 `ready:true`가 되면 시험 어댑터가 새 엔진에 목소리를 올리고 워밍업까지 한다. 여기에
   계약 시험과 `/tts/stream` 몇 번을 보낸다.
3. 리드에게 알리고, 라이브 터널의 서버 쪽 포트를 바꾼다. 먼저 `tunnel.sh`·`run-engine.sh`·`deploy.sh`의 기본값을 새 슬롯으로
   고친다. 그다음 `curl -s localhost:8794/health`에서 `inflight`와 `queue`가 0인 순간에 옛 터널 루프를 끄고
   (`kill $(cat ~/Library/Logs/mosi-tts-remote/tunnel.pid)`, trap이 ssh까지 정리) 바로 `services/tts-remote/up.sh`로 새 터널을 띄운다.
   어댑터는 그대로 두므로 앱 URL도 그대로다. 어댑터는 2초마다 엔진을 확인한다. 그래서 확인이 막 끝난 직후에 바꾸면, 터널이
   끊긴 시간이 2초보다 짧은 한 어댑터는 엔진이 사라진 것을 보지 못한다.
4. 새 터널로 `:8794/health`가 `ready:true`이고 `/tts/stream`이 되는지 본 다음 옛 엔진을 지운다:
   `ssh gpu-host 'docker stop mosi-tts-b && docker rm mosi-tts-b'`. 시험 터널·어댑터는 같은 `TTS_RUN_DIR`로 `down.sh`.

2026-11-12 A(GPU 4) → B(GPU 5) 교체 기록:

- B는 재시작 없이 5분 42초 만에 준비됐다.
- 시험 어댑터(:18794)로 확인한 결과는 다음과 같다.
  - 계약 시험 12개 모두 통과.
  - 웜 TTFA 10회: 155~183 ms, 중앙값 168 ms. A와 같다.
- 라이브 터널 교체:
  - `inflight` 0인 상태에서 어댑터의 엔진 확인이 끝난 직후에 바꿨다.
  - 옛 ssh는 0.01초 만에 내려갔고, 새 터널은 1.24초 뒤 엔진 `/health`에 응답했다. 끊긴 시간은 1.25초다.
  - 어댑터 로그에 `engine unreachable`도 실패한 요청도 없었다. 다만 그때 어댑터는 503을 기록하지 않았으므로, 그 1.25초 사이에
    들어온 요청이 있었다면 503을 받았을 수 있다.
- 교체 직후 :8794로 보낸 5문장: TTFA 137~171 ms, RTF 0.19~0.26. 그 뒤 A를 지워 GPU 4는 2 MiB로 비었다.

처음부터 다시 설치할 때(가중치와 이미지가 없을 때):

```sh
ssh gpu-host 'export PATH=$HOME/.local/bin:$PATH; mkdir -p /mnt/shared/mosi-tts/hf &&
  HF_HOME=/mnt/shared/mosi-tts/hf uvx --from "huggingface_hub[hf_xet]" hf download fishaudio/drama-3'   # 41.5 GB, 약 1.5분
services/tts-remote/gpu/deploy.sh   # 이미지가 없으면 빌드도 한다 (약 2분, 레이어 1 GB)
```

이미지는 서버에 이미 있던 `vllm/vllm-openai:v0.32.0`(33 GB, torch 2.13 cu130, sm_120 커널 포함) 위에 `vllm-omni==0.32.0`만 얹는다.
torch·vllm·transformers는 그대로 두고, diffusers가 요구하는 `huggingface-hub<2` 상한만 override로 무시한다(TTS 경로는
diffusers를 쓰지 않는다). 바뀐 패키지는 accelerate 1.15 → 1.12 하나다.

## API (services/tts와 같음)

| 요청 | 응답 |
|---|---|
| `GET /health` | `{"ok":true,"ready":bool,"model":"fishaudio/drama-3","voices":["pickle","pickle-calm"],"sampleRate":44100,"queue":n,"busyMs":n,"inflight":n,"slots":12,"backend":"…"}` |
| `POST /tts` `{"text":1~600자,"voice"?,"format"?:"mp3"\|"wav","direction"?}` | `audio/mpeg`(24 kHz 64 kbps, −16 LUFS) 또는 `audio/wav`(44.1 kHz), 헤더 `X-Audio-Duration`, `X-Gen-Ms` |
| `POST /tts/stream` (같은 본문) | `audio/L16` **s16le 모노 44100 Hz**(`X-Sample-Rate: 44100`), 엔진이 디코딩하는 대로 바로 넘김, `Content-Length` 없음 |

오류도 같다: 400 `bad_json`/`empty_text`/`unknown_voice`/`bad_format`, 413 `too_long`, 503 `loading`(터널·엔진 없음),
500 `synthesis_failed`, 404 `not_found`. 텍스트 정리(`spoken`), 문장 나누기, 6글자 미만 조각 합치기, 문장 사이 0.22초 쉼,
`direction`을 문장마다 `[큐] ` 꼴로 앞에 붙이기, 스트림 상한(1.0초 + 글자당 0.24초)과 `/tts` 재시도 범위(2.0초 + 글자당 0.36초, 3번까지)는
`services/tts`와 같은 규칙이다.

다른 점:

- **`queue`의 뜻**: Mac은 한 번에 한 줄만 만들어서 `queue` = 기다리거나 도는 줄 수였다. GPU 엔진은 여러 줄을 한꺼번에
  만든다(배칭). 어댑터는 엔진에 동시에 보내는 문장을 `slots`개(기본 12, 엔진 한도 16)로 묶고, `queue` = "새 요청이 몇 줄
  뒤에서 기다려야 하나" = 자리를 기다리는 문장 수 + (자리가 다 찼으면 1)로 보고한다. 12문장까지는 `queue`가 0이므로,
  `apps/server`의 "queue ≥ 2면 스트림 거절·전화는 `<Say>`"와 `services/meet`의 "queue > 0이면 바쁨"이 동시에 몇 줄
  나가는 정도로는 걸리지 않는다. 동시 14줄을 보내 보면 `queue`가 3 → 1 → 0으로 줄어든다. 요청 수는 `inflight`.
- **`/tts`는 문장들을 동시에**(한 요청에 최대 4개) 엔진에 보낸다. 배칭되므로 전체 시간 ≈ 가장 긴 문장이다. 한 문장이
  실패하면 아직 시작하지 않은 문장은 취소하고 바로 답한다(터널·엔진 문제면 503, 그 밖에는 500).
- **스트림의 200은 첫 소리를 받은 뒤에** 보낸다. 엔진이 소리 없이 실패하면 빈 200 대신 503/500 JSON이 간다. 클라이언트가
  60초 동안 읽지 않으면 연결을 끊고 엔진 자리를 돌려받는다.
- **무음 가드**: Drama-3는 가끔 첫 마디만 하고 `max_new_tokens`까지 무음을 낸다(모델 카드와 vLLM-Omni 레시피에 적힌 알려진
  동작). 말이 시작된 뒤 1.2초 넘게 조용하면 그 문장을 거기서 끊고(끝 0.25초만 남김) 다음 문장으로 간다. 처음 0.25초의
  쉼은 바로 넘기고 그 뒤만 잡아 둔다(문장 안의 짧은 쉼이 늦게 도착하지 않게). 말이 시작되기 전
  1.5초 동안 소리가 없으면 그 테이크를 버리고, 스트림에서도 아직 무음만 나갔으므로 한 번 더 만든다. 이번 230여 줄에서는
  한 번도 걸리지 않았다.
- **목소리 업로드**: 어댑터는 `voices/<id>.wav`+`.txt`를 엔진에 `POST /v1/audio/voices`로 한 번 올리고
  (`mosi-<id>-<내용 해시>`, 클립이 바뀌면 새 이름으로 다시 올리고 옛 것은 지움), 이후 요청은 그 이름만 보낸다. 엔진이 참조
  클립의 인코딩 결과를 기억하므로 매번 클립을 보낼 때보다 첫 소리가 50~70 ms 빠르다. 업로드가 안 되면 GPU 서버의
  `~/mosi-tts/voices/<id>.wav`를 `file:///voices/<id>.wav`로 보낸다. **주의**: 엔진은 모르는 목소리 이름을 받으면 오류 없이
  기본 목소리로 말한다. 그래서 어댑터가 30초마다 업로드 목록을 확인하고, 없어진 목소리는 바로 클립 경로로 바꾼 뒤 다시
  올린다(지워 보니 2~30초 안에 다시 올라갔다).
- **샘플링**: 엔진 기본값(temperature 1.0, top_p 0.9, top_k 30, 반복 인식 재샘플)을 쓴다. vLLM-Omni의 Drama-3 경로는 요청별
  temperature를 받지 않는다(`max_new_tokens`만 받는다). Mac은 0.7/0.7/30이었다.
- 텍스트는 어디에도 기록하지 않는다. 어댑터 로그는 글자 수와 시간(그리고 503 사유)만, 엔진은 INFO 레벨에서 요청 본문을 남기지 않는다
  (`--enable-log-requests` 꺼짐, 텍스트는 DEBUG에서만 찍힘). uvicorn 접근 로그도 껐다.

## 측정 (2026-11-12, Mac → 터널 → GPU 4, 목소리 `pickle`)

엔진이 GPU 4(슬롯 A)에 있을 때 잰 값이다. GPU 5(슬롯 B)로 옮긴 뒤에도 웜 TTFA는 같았다(137~183 ms, 위 "엔진 교체" 기록).

TTFA는 요청을 보낸 뒤 Mac에서 첫 PCM 바이트를 받기까지, 총 시간은 마지막 바이트까지, RTF = 총 시간 ÷ 오디오 길이다.
`POST /tts/stream`을 :8794로 보냈다. 웜은 5회 반복한 값의 중앙값(괄호는 최소~최대)이다.

| # | 글자 | 웜 TTFA | 웜 총 시간 | 오디오 | 웜 RTF | 10분 쉰 뒤 TTFA | 10분 쉰 뒤 총 시간 | 10분 쉰 뒤 RTF |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 183 ms (165~203) | 0.40 s | 1.44 s | 0.28 | 241 ms | 0.44 s | 0.32 |
| 2 | 14 | 152 ms (149~179) | 0.58 s | 2.60 s | 0.23 | 141 ms | 0.58 s | 0.22 |
| 3 | 25 | 160 ms (141~168) | 1.06 s | 4.63 s | 0.23 | 148 ms | 1.03 s | 0.22 |
| 4 | 34 | 173 ms (153~184) | 1.35 s | 6.64 s | 0.20 | 158 ms | 1.38 s | 0.20 |
| 5 | 51 | 170 ms (146~171) | 1.84 s | 9.38 s | 0.20 | 136 ms | 1.84 s | 0.20 |

- 웜 25회: TTFA 중앙값 169 ms, p90 183 ms, 최대 203 ms.
- **10분 동안 아무 요청 없이 둔 뒤에도 콜드 스타트가 없다.** 첫 요청 241 ms(어댑터가 그때는 요청마다 엔진 상태를 한 번 확인해서
  터널 왕복 한 번이 더 들어갔다. 지금은 2초마다 따로 확인한다), 그다음부터 136~158 ms. 가중치가 GPU 메모리에 그대로 있다.
- **동시 3개**(25·34·51글자, 5회): TTFA 239~337 ms(중앙값 약 300), RTF 0.24~0.32. **동시 8개**(2회): TTFA 425~479 ms,
  RTF 0.30~0.56. **동시 14개**(1회, 자리 12개라 2줄은 기다림): TTFA 중앙값 515 ms, 최대 1.1 s, RTF 최대 1.1.
  같은 배치로 들어간 줄들은 TTFA가 거의 같다.
- `POST /tts`(문장들을 동시에): 3문장 46글자, 7.1초 분량 wav가 0.78초. 14글자 mp3가 0.69초.
- 나눠 보면: GPU 서버 안에서 엔진만 잰 TTFA는 업로드한 목소리로 127~160 ms(클립을 매번 보내면 173~201 ms)다. 터널(왕복
  약 15 ms)과 어댑터가 더하는 시간은 10~40 ms 정도다. 모델 카드의 H200 수치(SGLang-Omni 89 ms, vLLM-Omni H100 126 ms)보다
  조금 느린데, RTX PRO 6000 Max-Q(300 W)이고 sm_120에서는 Hopper 전용 Triton 샘플링·fused 커널이 꺼지기 때문이다.

리드가 앱 서버 경로(`/api/tts/stream`)에서 잰 값: 첫 바이트 0.21~0.28 s, 38글자 한 문장이 1.15 s에 끝남.

**Mac :8790과 비교.** Mac에는 라이브 Meet 시험 중이라 요청을 더 보내지 않았다. 대신 같은 시간대 Mac TTS 로그에 남은 실제 값을
옮긴다: 실제 스트림의 첫 소리 1.7 s / 11.5 s / 19.7 s / 99 s, keep-warm 한 마디 3~95 s(대부분 "pages were cold"). 웜일 때는
TTFA 0.23~0.4 s, RTF 약 0.8~0.9(9.3 s 분량에 7.5 s)다. GPU 쪽은 웜 TTFA가 0.14~0.2 s로 Mac 웜 상태보다도 빠르고, RTF는
약 4배 낮다(0.2 대 0.8~0.9). 무엇보다 쉬었다 와도 느려지지 않고, 여러 줄을 동시에 만든다.

**음질 확인.**

- 받아쓰기 왕복(Mac `services/stt`, Whisper large-v3-turbo): 5문장 모두 내용이 맞다. 차이는 숫자 표기("세 시" → "3시",
  "십이 퍼센트" → "12%")와 "시안" → "시한" 한 곳뿐이다. 한국어 발음은 문제없다.
- 같은 화자인지: 참조 클립 `pickle.wav`의 F0 중앙값이 246 Hz이고 생성한 5문장은 218~298 Hz(평균 255)다. 참조 없이
  (`voice: none`) 만든 대조군은 380 Hz로 확연히 다르다. 참조 목소리를 따라가고 있다는 뜻이지만, 같은 사람으로 들리는지는
  사람이 직접 들어 봐야 한다.
- 무음 가드에 걸린 줄: 측정·시험과 다른 팀원 사용을 합친 230여 줄 중 0줄. 길이 범위를 벗어나 다시 만든 줄(`/tts`)도 0줄.

## SGLang-Omni 엔진 (2026-11-14, GPU 6에서 vLLM-Omni와 같은 카드 비교)

fish-speech README는 Drama-3 서빙에 SGLang-Omni를 권한다. 쿡북 수치는 H200 한 장에서 단일 스트림 TTFA 89 ms, RTF 0.131(동시
16에서 0.373)이다. 같은 카드에서 vLLM-Omni와 속도와 용량을 비교하려고 환경, 실행 스크립트, 어댑터 전환, 벤치를 준비했고,
2026-11-14에 측정용으로만 빌린 GPU 6에서 두 엔진을 차례로 쟀다. 둘 다 내렸고 **라이브로는 아직 쓰지 않는다.**
- GPU를 쓰는 일은 쓸 GPU를 정한 뒤에만 한다. 그 밖에는 import 확인도 `CUDA_VISIBLE_DEVICES=""`로만 한다.

### 측정 결과 (2026-11-14, GPU 6, RTX PRO 6000 Blackwell Max-Q, 목소리 `pickle`)

같은 벤치(`bench/engine_bench.py`)를 같은 순서로 돌렸다. 첫 패스는 GPU 서버 안에서, 엔진이 처음 받는 트래픽(차가운 상태)이다.
두 번째 패스는 Mac 터널로 바로 이어서(데워진 상태, 터널 왕복 약 23 ms 포함) 돌렸다. vLLM은 `mosi-drama3-c32.yaml`(동시 32)이다.
용량은 TTFA p95 ≤ 300 ms이면서 RTF p95 ≤ 0.6인 최대 동시 스트림 수다.

| | SGLang-Omni 0.2.0 | vLLM-Omni 0.32.0 |
|---|---|---|
| 용량, 두 번째 패스(데워짐, 터널) | **11** | 6 |
| 통과하는 최대 수준, 각 수준의 첫 동시 묶음(N줄)을 뺀 엇갈린 줄만(데워짐) | 12 (16은 RTF p95 0.60으로 경계) | 12 (c=7은 317 ms로 불합격, 수준마다 17~24줄이라 잡음) |
| 용량, 첫 패스(차가움, 서버 안) | 3 | 5 |
| TTFA p50, c=1, 서버 안 | 78 ms | 113 ms |
| TTFA p95, 32개 동시 몰림(데워짐) | 544 ms | 1,191 ms |
| 처리량, c=32(오디오초/벽시계초) | 40.0 | 42.2 |
| GPU 메모리 최대 | 76.5 GB | 65.6 GB |
| 시작에서 /health 200까지 | 353 s | 357 s |
| 오류 / 1.2초 넘는 무음 | 0 / 0 (783줄) | 0 / 0 (792줄) |

- SGLang의 이득은 처리량이 아니라 지연이다. 부하가 낮을 때 TTFA가 35~60 ms 빠르고, 한꺼번에 몰리는 요청을 잘 받는다.
  엇갈려 들어오는 꾸준한 부하에서는 두 엔진이 거의 같다. 포화 처리량과 고부하 RTF는 vLLM이 조금 낫다.
- 1초 넘는 줄:
  - SGLang 첫 패스에서 45줄이었다. 모두 c=4, 12, 32에서 그 수준의 첫 동시 묶음이었고(1.1~1.6 s), 두 번째 패스에서는 0줄이었다.
    처음 보는 배치 크기에서 커널을 한 번 컴파일하는 비용이다.
  - vLLM은 두 패스 모두 c=32 첫 묶음의 뒤쪽 절반이었다(15줄, 18줄). 32개가 몰릴 때 줄을 서는 구조적 지연이다.
- sm_120: SGLang 시작 로그에 `Drama 3 codebook sampling: PyTorch, untested GPU sm_120`과
  `Drama 3 tower fused layers: off, untested GPU sm_120`이 나온다. vLLM은 Blackwell에서 DeepGemm을 끄고 CUTLASS를 쓴다.
- 엔진 로그에 텍스트가 없는지 확인했다. 한글이 SGLang 1,895줄과 vLLM 3,642줄 모두에서 0자였다.
- 한 요청(3문장 답 전체)과 문장별 요청은 두 엔진 모두 TTFA와 총 시간이 거의 같았다. 고르는 기준은 억양뿐이다.
- 원본 행, 표, wav는 측정한 사람의 작업 폴더에 있다(커밋하지 않음). 서버 `~/mosi-tts/bench-out/`에도 사본이 있다.

### 워밍업 묶음 (어댑터, sglang 모드)

위의 1회성 컴파일(1.1~1.6 s)이 통화 첫 마디에 걸리지 않게, 어댑터는 엔진이 뜬 뒤 다음 순서로 준비한다.
1. 목소리를 올린다.
2. 목소리마다 한 줄씩 보낸다(기존 워밍업).
3. `TTS_WARM_BURSTS`(기본 4,8,12,16)의 각 크기만큼 동시에 줄을 보낸다. 고정 문장이고 목소리는 `pickle`이다.
   - 이 묶음은 어댑터 슬롯을 거치지 않는다. 엔진이 그 수를 한 번에 보게 하려는 것이다.
   - 묶음이 도는 동안 `/health`는 `ready: false, warming: true`이고, 요청은 엔진이 로딩 중일 때처럼 503 `loading`을 받는다.
   - 묶음이 끝나야 `ready: true`가 된다.
   - 묶음 단계에서 예상 밖의 예외가 나도 어댑터는 막히지 않는다. 예외 이름만 로그에 남기고(`warm-up bursts failed: <이름>`)
     그대로 `ready: true`가 된다. 첫 통화가 차갑게 걸리는 편이 재시작 전까지 503에 묶이는 것보다 낫다.
4. 이어서 엇갈린 워밍업을 돈다(`TTS_WARM_LEVELS`, 기본 2,4,8,12,16). 각 레벨 c에서 c개의 줄을 쉬지 않고 이어 보낸다.
   - 각 레벨은 `TTS_WARM_LEVEL_S`(14초) 동안 돈다. 첫 줄들의 시작은 1초에 걸쳐 흩뜨린다.
   - 실제 통화는 이미 말하고 있는 줄들 사이에 새 줄이 하나씩 끼어드는 모양이다. 동시 묶음은 이 모양을 만들지 못한다.
   - 2026-11-15 gpu-host GPU 6에서는 묶음만 돈 뒤에도 실제 부하가 차가웠다.
     - 어댑터를 거친 첫 접촉: c=2 TTFA p95 900 ms
     - 엔진 closed loop: c=4 820 ms, c=8 1,045 ms, c=16 1,791 ms. c=12(381 ms)보다 나빠서 수가 커질수록 나빠지는 모양이 아니다.
   - 묶음과 마찬가지로 슬롯을 거치지 않는다. 레벨마다 첫 소리 p50/p95/max만 로그에 남긴다(`warm-up level <c>: ...`).
   - 예외가 나면 `staggered warm-up failed: <이름>`을 남기고 ready가 된다. 한 줄이 3번 실패하면 그 작업자는 멈춘다.
   - 기본값이면 묶음과 합쳐 엔진이 뜬 뒤 약 80초 동안 `warming: true`다.
   - 같은 날 GPU 4에서 이 어댑터로 다시 쟀다. 같은 SGLang-Omni 0.2.0이고 카드 모델도 같다.
     - 레벨별 첫 소리 p95는 c=2 240, c=4 249, c=8 263, c=12 281, c=16 295 ms였다. 실패한 줄은 0개다.
     - 엔진이 뜬 뒤 ready까지 80.9초가 걸렸다(묶음 5.5초, 엇갈린 워밍업 73.9초).
     - 어댑터를 거친 첫 접촉의 용량은 1에서 4가 되었다. c=2 TTFA p95는 900에서 230 ms로, c=4는 808 ms(오류 12)에서 244 ms로
       내려갔다. 첫 접촉 129줄 중 1초를 넘은 줄과 오류는 0개다.
     - 엔진 closed loop 용량은 3에서 7이 되었다. 바로 이어 돈 두 번째 패스는 5였다. 수준마다 24줄이라 p95가 두 번째로 느린 줄
       하나로 정해지고, 300 ms 기준에서 흔들린다. c=6에서는 첫 패스(269 ms)가, c=8~24에서는 두 번째 패스가 나았다.
     - 엔진의 프리필 CUDA graph 사용(`GET /model_info`)은 워밍업 직후 replay 367번에 eager 1번, 측정을 모두 마친 뒤 replay
       911번에 eager 9번이었다.
- 엔진이 `TTS_REWARM_AFTER_S`(60초)보다 짧게 끊겼다 돌아오면 묶음도 엇갈린 워밍업도 다시 하지 않는다. 이런 끊김은 터널이
  잠깐 흔들린 것이고, 엔진을 재시작하면 약 6분이 걸리기 때문이다. 그보다 길게 끊겼으면 다시 한다. 끊긴 시점은 실패한 첫 확인이다.
- vllm 모드는 바뀐 것이 없다. 묶음을 보내지 않고, 엔진이 뜨면 바로 ready다.
- `TTS_SLOTS` 기본값은 sglang 모드에서 11이다(위 용량). vllm 모드는 그대로 12다.
- 가짜 엔진으로 시험했다(2026-11-14, Mac 18894/18895).
  - `--cold-ms 1500`은 처음 보는 동시 수에서 첫 소리를 1.5 s 늦추는 옵션이다.
  - 묶음이 도는 동안 POST는 503이었다. 엔진은 16개 동시를 실제로 받았고, 이후 8개 동시 통화의 첫 바이트는 최대 80 ms였다.
    묶음을 끄면(`TTS_WARM_BURSTS=""`) 같은 8개 동시 통화가 1,577 ms였다.
  - 4.5초 끊김에서는 묶음을 다시 보내지 않았고, 11초 끊김에서는 다시 보내 ready를 막았다.
  - 묶음 함수가 예외를 던지게 바꿔 끼워도(시험 스크립트에서만) 로그에 `RuntimeError`만 남고 ready가 됐다.
    `TTS_WARM_BURSTS="0,4,-2"`는 4 묶음 하나만 보냈다.
  - 계약 시험 12개는 sglang과 vllm 두 모드에서 모두 통과했다. 어댑터 로그에 한글은 0자였다.

### 엔진 상태 확인 (어댑터, 두 모드 공통)

2026-11-15 gpu-host GPU 6에서 SGLang-Omni를 측정할 때, 부하가 걸리자 엔진 `/health`가 그때 어댑터의 확인 제한 시간 1.5초보다 늦게
답했다.
- 어댑터는 엔진을 끊긴 것으로 보고(`engine unreachable`, 01:37:49와 01:38:55) 2초 뒤 다시 ready로 돌아왔다.
- 그 사이 들어온 호출 69개가 503 `loading`을 받았다. 스트림은 모두 정상으로 돌고 있었다.
- 두 번째는 어댑터가 놀고 있을 때였다. 벤치가 엔진에 직접 부하를 주던 중이었다.

이제는 이렇게 한다.
- 엔진 확인은 확인 스레드만 한다. `GET /health`를 2초마다 보내고, 제한 시간은 `TTS_PROBE_TIMEOUT_S`(5초)다.
  요청과 어댑터 `/health`는 마지막으로 본 상태만 읽고, 직접 확인하지 않는다.
- 끊긴 것으로 보는 경우는 두 가지뿐이다.
  - 확인이 `TTS_PROBE_FAILS`(3)번 연속 실패했을 때. 로그: `(3 probes failed in a row)`
  - 엔진으로 보낸 줄이 연결부터 안 될 때(refused, 또는 터널이 응답 없이 닫음). 이때는 바로 본다.
    로그: `(a line could not connect: <예외 이름>)`
- 엔진이 200으로 답한 줄은 통과한 확인으로 센다. 그래서 부하 중에 `/health`만 늦을 때는 줄이 들어가고 있는 한 503이 나지 않는다.
- 줄이 시간 초과되거나 중간에 끊기면 그것만으로 끊김을 증명하지 못한다. 확인 스레드가 그 자리에서 다시 확인한다.
- 1.5초 넘게 걸린 확인은 개수와 최대값만 30초에 한 번 로그에 남긴다(`engine /health slow: ...`).
- 끊긴 뒤 돌아왔을 때의 재워밍업 판단(`TTS_REWARM_AFTER_S`)과 세대 규칙은 그대로다.

### 무엇을 어디에 두었나

| 위치 | 내용 |
|---|---|
| `gpu/sglang-omni-0.2.0.lock.txt` | 307개 패키지를 모두 고정한 잠금 파일. Mac에서 `uv pip compile`로 만들었다(명령은 파일 머리에 있다) |
| `gpu/sglang-overrides.txt` | protobuf 한 줄. sglang-omni 0.2.0의 pyproject `[tool.uv]`에 있는 것과 같고, 없으면 의존성이 풀리지 않는다 |
| `gpu/install-sglang.sh` | GPU 서버에서 NFS에 환경을 만든다. GPU는 쓰지 않는다 |
| `gpu/run-sglang.sh` | 엔진 컨테이너 시작. 가드는 `run-engine.sh`와 같다 |
| `gpu/mosi-drama3-c32.yaml` | vLLM-Omni 비교용 변형. `max_num_seqs` 32, 나머지는 `mosi-drama3.yaml`과 같다 |
| `bench/engine_bench.py` | 두 엔진에 같은 부하를 거는 벤치. 엔진 포트에 바로 붙는다 |
| `bench/fake_engine.py` | GPU 없이 어댑터와 벤치를 시험하는 가짜 엔진. `--kind sglang` / `--kind vllm`. `--cold-ms`는 처음 보는 동시 수에서 첫 소리를 늦춘다 |
| GPU 서버 `/mnt/shared/mosi-tts/sgl/` | `python/`(CPython 3.12.13, 113 MB), `uv-cache/`(13 GB), `venv-0.2.0/`(캐시에서 하드링크, 추가 818 MB), `cache/`(런타임 캐시와 업로드 목소리) |

`/`에는 아무것도 더하지 않았다. 이미지는 서버에 이미 있던 `vllm/vllm-openai:v0.32.0`을 쓴다. 컨테이너 로그는 최대
50 MB × 3이다.

### 버전

- `sglang-omni==0.2.0`(PyPI, 2026-10-27)과 그 고정: sglang 0.5.22, sglang-kernel 0.4.9, flashinfer-python 0.7.1, torch 2.14.1
  (CUDA 13.0 빌드), triton 3.8.0, transformers 5.19.0, Python 3.12.13. main은 sglang 0.5.23과 flashinfer 0.7.2로 올라가 있다.
- prerelease는 `if-necessary`로 풀었다. 그래서 gradio, safetensors, lxml 등은 정식 버전이 들어가고, rc는 cuda-tile 1.6.0rc5
  하나뿐이다. cuda-tile은 wheel-stub이라 설치할 때 pypi.nvidia.com에서 실제 wheel을 받는다.
- 0.2.0 이후 main의 Drama-3 커밋 가운데 우리에게 필요한 것은 f461b8e("첫 스트리밍 창을 10 → 4 프레임") 하나다. 소스 변경은
  config 기본값 한 줄뿐이라 `--vocoder.factory.stream_stride 4`로 똑같이 맞춘다(`MOSI_SGL_STREAM_STRIDE`). 그래서 git main은
  쓰지 않는다. 나머지 커밋은 텐서 병렬, 기본으로 꺼져 있는 참조 샘플링, 프로파일링 이벤트다.
- 코덱: SGLang-Omni는 기본으로 `fishaudio/s2-pro@1de9996`의 codec.pth를 받으려 한다. 이 파일은 NFS에 있는 drama-3(78e5ab7)의
  codec.pth와 sha256이 같다(74fc41c5…). 그래서 `--vocoder.factory.codec_path`로 drama-3 스냅샷 디렉터리를 주고, 엔진은
  완전히 오프라인으로 돈다.

### 설치 (GPU 없이, 한 번)

```sh
scp services/tts-remote/gpu/install-sglang.sh services/tts-remote/gpu/run-sglang.sh \
    services/tts-remote/gpu/sglang-omni-0.2.0.lock.txt gpu-host:mosi-tts/
ssh gpu-host 'cd ~/mosi-tts && ./install-sglang.sh'   # 2026-11-14: 패키지 받기 1분 15초. 끝에 import 확인과 크기를 찍는다
```

- 호스트의 uv(0.11.30)가 uv 관리 Python 3.12를 받고, venv를 잠금 파일로 `uv pip sync` 한다.
- 캐시와 venv가 같은 NFS 볼륨이라 venv는 하드링크로 채워진다. 실제로 더 쓰는 것은 바이트코드 몫뿐이다. 컨테이너가 venv를
  읽기 전용으로 마운트하므로 바이트코드를 미리 만들어 둔다(`--compile-bytecode`).
- import 확인 로그의 "Cannot detect CUDA architecture", "causal_conv1d_fn" 경고는 GPU를 숨기고 돌려서 나는 것이다. CUDA
  경로에서만 정의되는 이름이다.

### 실행 방식: 서버에 있는 이미지 + NFS venv 컨테이너

호스트 프로세스가 아니라 컨테이너로 띄운다. 이유는 다음과 같다.

- `--gpus device=N` 때문에 다른 GPU가 아예 보이지 않는다.
- `--restart unless-stopped`, 루프백 publish, 로그 로테이션, `docker stop/rm`이 vLLM 엔진과 같다.
- 이미지를 새로 받지 않는다. `vllm/vllm-openai:v0.32.0`에 Triton이 쓰는 gcc 13, CUDA 13.0 nvcc, libavcodec이 이미 있다.

venv는 NFS의 같은 경로에 읽기 전용으로 마운트하고, 진입점은 `venv-0.2.0/bin/sgl-omni`다. 이미지의 `LD_LIBRARY_PATH`에는
CUDA 13.0 툴킷이 들어 있다. 그대로 두면 pip로 들어온 CUDA 13.x 라이브러리를 가릴 수 있어서 NVIDIA 드라이버 디렉터리만
남긴다. 처음 띄울 때 이 부분이 문제가 되면 로그에 라이브러리 오류로 나온다.

```sh
ssh gpu-host 'cd ~/mosi-tts && MOSI_SGL_GPU=<받은 GPU> ./run-sglang.sh'   # mosi-sgl, 서버 127.0.0.1:8797
ssh gpu-host 'curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:8797/health'   # 200이면 준비 (시작 중엔 503)
ssh gpu-host 'docker logs --tail 50 mosi-sgl'                                # 시작 로그 (샘플링/퓨즈 경로가 찍힌다)
ssh gpu-host 'docker stop mosi-sgl && docker rm mosi-sgl'                     # 정지와 삭제
```

- `MOSI_SGL_GPU`에는 기본값이 없다. 받은 GPU를 직접 적는다.
- 가드는 `run-engine.sh`와 같다.
  - GPU 0~3은 거부한다.
  - 프로세스가 있거나 2 GB 넘게 쓰인 GPU는 거부한다.
  - 같은 이름으로 돌고 있는 컨테이너는 바꾸지 않는다.
  - 2026-11-14에 GPU 2·3·9와 빈 값, 사용 중인 GPU 4로 시험했고 모두 거부했다. 컨테이너는 만들어지지 않았다.
- 그 밖의 변수: `MOSI_SGL_NAME`, `MOSI_SGL_PORT`, `MOSI_SGL_MAX_RUNNING`(32), `MOSI_SGL_STREAM_STRIDE`(4),
  `MOSI_SGL_EXTRA_ARGS`(예: `--mps on`).
- 메모리(96 GB 카드, 94.97 GiB): 쿡북 기본값을 그대로 쓴다.
  - 엔진 0.70 + 보코더 0.10 + 전처리 예약 6 GiB = 82.0 GiB. 시작할 때의 검사(선언한 예산 합 ≤ VRAM)를 통과하고, 프로세스 3개의
    CUDA 컨텍스트 몫으로 약 13 GiB가 남는다.
  - 쿡북의 0.85는 같은 카드에 보코더가 있으면 OOM 위험이 있다고 적혀 있어서 쓰지 않는다.
  - 동시 요청 상한은 기본 16 대신 32로 올렸다. KV는 엔진 몫 안에서 잡힌다.
- sm_120(RTX PRO 6000)에서는 Triton 샘플링과 퓨즈된 코드북 타워 레이어가 꺼지고 PyTorch 경로로 돈다. 쿡북에 그렇게 적혀
  있고, 시작 로그에 `untested GPU sm_120`으로 나온다. vLLM-Omni도 같은 이유로 같은 것들이 꺼져 있다.
- 포트(서버, 루프백): 8795·8796은 vLLM 슬롯 A·B, 8797은 SGLang(`mosi-sgl`), 8798은 비교용 vLLM(`mosi-vllm-bench`)이다.

### 어댑터로 붙이기

엔진 API가 vLLM-Omni와 거의 같다.

- 같은 것:
  - 스트림 요청 필드(`input`, `voice`, `stream`, `stream_format: audio`, `response_format: pcm`, `max_new_tokens`)와 응답
    형식(s16le, `X-Sample-Rate: 44100`).
  - 목소리 업로드(`POST /v1/audio/voices`, 같은 multipart 필드), 목록, 삭제.
  - `/health`가 준비되면 200, 시작 중이면 503.
- 다른 것:
  - 업로드하지 않은 목소리를 보낼 때 어댑터는 `references: [{data: base64 wav, text}]`로 클립을 직접 보낸다. 그래서 GPU 서버의
    voices 사본이 필요 없다.
  - SGLang-Omni는 요청별 temperature/top_p/top_k를 받는다. 쿡북은 주 토큰에 top_k 30 같은 상한을 두면 첫 마디 뒤에 말이 끊길 수
    있다고 해서, 어댑터는 아무것도 보내지 않고 엔진 기본값(temperature 1.0, top_p 0.9, 주 토큰 상한 없음, 코드북 top-k 30)을
    쓴다. vLLM 쪽은 배포 설정의 top_k 30이 주 토큰에도 걸린다.
- 업로드한 목소리는 요청마다 data URL로 전처리 단계에 가지만, 인코딩한 참조는 **내용 해시로 캐시**된다. 그래서 첫 줄 뒤로는
  미리 인코딩한 vq_codes를 보내는 것과 거의 같다. 어댑터의 워밍업이 그 첫 줄을 맡는다.

라이브로 바꾸는 순서는 위 "엔진 교체"와 같다. Mac의 두 번째 터널(18895 → 서버 8797)과 두 번째 어댑터를 띄운다.

```sh
TTS_RUN_DIR=$HOME/Library/Logs/mosi-tts-remote-sgl TTS_PORT=18894 TTS_ENGINE=127.0.0.1:18895 TTS_ENGINE_KIND=sglang \
  TTS_ENGINE_PORT=18895 MOSI_TTS_PORT=8797 services/tts-remote/up.sh
```

계약 시험을 통과하면 리드의 OK를 받고 :8794를 옮긴다. 라이브 어댑터도 `TTS_ENGINE_KIND=sglang`으로 다시 띄워야 한다. 그러면
`TTS_SLOTS`는 기본 11(측정한 용량)이 되고, 워밍업(묶음과 엇갈린 워밍업)이 끝난 뒤에 ready가 된다. 엔진이 뜬 뒤 약 80초 더 걸린다.

GPU 없이 한 시험(2026-11-14, 가짜 엔진, Mac 18894/18895):
- `TTS_ENGINE_KIND=sglang`에서 계약 시험 12개 모두 통과했다. SGLang-Omni 0.2.0이 받지 않는 필드를 보내면 가짜 엔진이 400을
  주게 해 두었는데, 걸린 요청이 0개였다.
- 업로드가 거부될 때 `references.data` 대체 경로가 동작했다.
- 기본값(vllm) 모드도 계약 12개를 통과했고 `file://` 대체 경로가 동작해 회귀가 없다.

GPU 없이 한 시험(2026-11-15, 가짜 엔진, Mac 18994/18995, 엔진 상태 확인과 엇갈린 워밍업):
- 부하 중 `/health`가 2~4초 걸리게 한 가짜 엔진(`--slow-health 2000-4000`)에 호출 8개를 30초 동안 이어 보냈다.
  - b8f192f 어댑터: 481개 중 158개가 503이었고, `engine unreachable`이 5번 찍혔다.
  - 이 어댑터: 492개 모두 200이었고 unreachable은 0번이다. `engine /health slow: 6 probes over 1.5 s ..., max 3821 ms`가 남았다.
- `/health`가 6~8초 걸려 확인이 매번 시간 초과돼도, 호출 6개를 40초 동안 보낸 493개가 모두 200이었다.
- 트래픽 없이 엔진을 멈췄다(SIGSTOP).
  - 4.5초 멈춤은 아무것도 바꾸지 않았다.
  - 25초 멈춤은 19.0초 뒤에 `(3 probes failed in a row)`로 끊김이 되었다. 그동안 호출은 503을 받았고, 다시 살리자 2.1초 뒤
    ready로 돌아왔다.
- 엔진이 사라지면 첫 호출의 연결 실패로 바로 끊김이 된다(503까지 5 ms). 엔진이 돌아오면 확인으로 1.6초 뒤 ready가 된다.
- 엇갈린 워밍업은 `--cold-key mix --cold-ms 1500`으로 쟀다. 처음 보는 섞임 모양(먼저 돌던 줄 수, 같이 들어온 순서)이면 첫 소리를
  1.5초 늦추는 설정이다. 워밍업 뒤 closed loop 2,4,8,11을 돌렸다.
  - 묶음만 돌았을 때: 269줄 중 26줄이 차가웠고, TTFB p95는 1.57초였다.
  - 기본 레벨(14초)까지 돌았을 때: 340줄 중 5줄이 차가웠고, p95는 0.08초였다.
- 짧은 끊김(5초)은 워밍업 없이 돌아왔다. `TTS_REWARM_AFTER_S`보다 긴 끊김에서는 묶음과 레벨을 다시 돌았다.
- 두 단계 모두 예외가 나도 이름만 남기고 ready가 된다. 1보다 작은 크기와 레벨은 버린다.
- 계약 시험 12개는 sglang과 vllm 두 모드에서 모두 통과했다. 어댑터와 가짜 엔진 로그에 한글은 0자였다.

### 벤치 (`bench/engine_bench.py`)

```sh
# SGLang-Omni (서버 8797) — 벤치가 자기 터널을 띄우고 끝나면 내린다. GPU 메모리는 nvidia-smi 읽기 전용 조회.
python3 -I services/tts-remote/bench/engine_bench.py run --engine 127.0.0.1:18895 --tunnel gpu-host:8797 \
  --gpu <n> --label sglang-gpu<n> --engine-name "sglang-omni 0.2.0" --out <결과 폴더> --refine
# 같은 GPU에서 vLLM-Omni (동시 32 변형, 서버 8798)
ssh gpu-host 'cd ~/mosi-tts && MOSI_TTS_DEPLOY=mosi-drama3-c32.yaml MOSI_TTS_NAME=mosi-vllm-bench MOSI_TTS_GPU=<n> MOSI_TTS_PORT=8798 ./run-engine.sh'
python3 -I services/tts-remote/bench/engine_bench.py run --engine 127.0.0.1:18896 --tunnel gpu-host:8798 \
  --gpu <n> --label vllm-gpu<n> --engine-name "vllm-omni 0.32.0" --out <결과 폴더> --refine
python3 -I services/tts-remote/bench/engine_bench.py compare <결과 폴더>/vllm-gpu<n>.json <결과 폴더>/sglang-gpu<n>.json
# 네트워크를 뺀 엔진 쪽 TTFA: 같은 벤치를 GPU 서버에서 돌린다 (서버 python3 3.10, 표준 라이브러리만 쓴다)
scp services/tts-remote/bench/engine_bench.py gpu-host:mosi-tts/
ssh gpu-host 'cd ~/mosi-tts && python3 -I engine_bench.py run --engine 127.0.0.1:8797 --ssh "" --gpu <n> \
  --voice-dir voices --label sglang-gpu<n>-local --engine-name "sglang-omni 0.2.0" --out bench-out --refine'
```

- 부하:
  - 통화 응답 모양의 한국어 고정 문장 24개(11~38자)를 두 엔진에 같은 순서로 보낸다.
  - 목소리는 업로드한 `pickle`이다. 어댑터와 같은 이름 `mosi-pickle-<해시>`를 쓰고, 없으면 벤치가 올린다.
  - PCM 스트림이고, `max_new_tokens`는 어댑터와 같은 상한(1.0초 + 글자당 0.24초)이다.
- 동시성은 1, 2, 4, 8, 12, 16, 24, 32다. 각 수준에서 그 수만큼 스트림을 계속 열어 두고 max(24, 3 × 동시성)줄을 보낸다.
- 수준마다 내는 값:
  - TTFA p50/p95(보낸 뒤 첫 PCM 바이트까지), RTF p50·평균·p95
  - 생성 오디오 초 ÷ 벽시계 초, 두 가지:
    - `audio_s_per_wall_s`: 스트림 N개가 모두 바쁠 때의 지속 처리량이다. N × Σ오디오 ÷ Σ줄 시간으로 구하고, 마지막 N줄은
      뺀다. 그 줄들은 큐가 비어 동시성이 줄어드는 꼬리와 겹치기 때문이다.
    - `audio_s_per_wall_s_overall`: 전체 오디오 ÷ 그 수준의 벽시계 시간이다. 꼬리가 들어가서 더 낮게 나온다.
  - 오류 수
  - 말이 시작된 뒤 1.2초 넘게 조용한 줄의 수(Drama-3의 무음 버릇)
  - GPU 최대 메모리와 평균 사용률
- 용량은 두 규칙으로 낸다. 둘 다 "그 수준과 그보다 작은 모든 수준이 통과하는 가장 큰 동시 스트림 수"다. `--refine`이면 규칙마다
  마지막 통과 수준과 첫 실패 수준 사이를 이분 탐색한다.
  - `max_streams_sla`: TTFA p95 ≤ 300 ms, RTF 평균 ≤ 0.6, 오류 0. 리드 브리프의 "RTF ≤ 0.6"을 평균으로 읽은 것이다.
  - `max_streams_sla_rtf_p95`: 같은 조건에서 RTF를 p95로 본다. 평균 줄이 아니라 95%의 줄이 0.6 안에 들어야 해서 더 엄격하다.
- 측정 위치: Mac에서 돌리면 TTFA에 터널 왕복이 들어간다. 두 엔진을 같은 위치에서 재면 비교는 공정하다. 터널 몫은
  `health_rtt_ms`(빈 `GET /health` 왕복)에 남긴다. 엔진만의 숫자가 필요하면 위처럼 GPU 서버에서 돌린다.
- 답 모드: 3문장 답 세 개를 각각 세 번 보낸다.
  - 한 요청으로 보내는 경우와, 문장마다 따로 보내고 0.22초 간격으로 잇는 경우(지금 어댑터 방식)를 비교한다.
  - TTFA와 총 시간을 재고 wav를 `<결과 폴더>/wav/`에 저장한다. 한 요청 쪽 억양이 더 자연스러운지 사람이 들어 본다.
- 출력은 `<label>.json`(모든 줄)과 `<label>.md`(표)다. 텍스트는 고정 문장이고 숫자만 찍는다.
  - JSON 최상위의 `engine`, `gpu`, `levels[]`(`concurrency`, `ttfa_p50_ms`, `ttfa_p95_ms`, `rtf_p50`, `rtf_p95`,
    `audio_s_per_wall_s`, `n`), `max_streams_sla`는 cost-model의 `tts_cost.py`가 그대로 읽는 형식이다.
- 가짜 엔진으로 시험했다(2026-11-14).
  - 동시 8까지만 받게 하니 두 규칙 모두 용량 9가 나왔다(`--refine`).
  - 동시 8의 지속 처리량은 32.8로 이론값 8 ÷ 0.245 = 32.7과 맞았다. 꼬리를 넣은 값은 28.2였다.
  - `tts_cost.py`가 이 JSON을 읽어 N = 9를 그대로 썼다. 터널과 GPU 조회도 확인했다.

## 위험과 주의

- **라이선스**: 가중치는 Fish Audio Community License다(`services/tts/README.md`의 라이선스 절 참고). 연구·비상업 용도로만
  쓴다. 특히 "제3자를 위한 호스팅 TTS 서비스"는 금지라서 이 엔진을 다른 팀이나 외부에 API로 열면 안 된다. 지금은 서버
  루프백에만 열려 있다. "Built with Fish Audio" 표기 의무도 같다. vLLM-Omni·vLLM은 Apache-2.0.
- **상태 확인 (리드용 한 줄)**: `curl -s -m 3 localhost:8794/health` → `"ready": true`면 정상이다. `ready:false`면 터널이나
  엔진 문제다(`tail ~/Library/Logs/mosi-tts-remote/{adapter,tunnel}.log`, `ssh gpu-host 'docker logs --tail 20 mosi-tts-b'`).
  응답이 없으면 어댑터가 죽은 것이다(`services/tts-remote/up.sh`).
- **자동 복구 없음**: launchd 감시자를 설치하지 않았다. Mac을 재시작하거나 터널·어댑터 프로세스가 죽으면 누군가 `up.sh`를
  돌릴 때까지 :8794가 없다. `tunnel.sh`가 ssh 재연결은 스스로 하지만, `tunnel.sh` 자체가 죽으면 되살리지 않는다.
- **엔진에는 인증이 없다**: GPU 서버에 로그인할 수 있는 사람은 누구나 127.0.0.1:8796으로 합성 요청을 보내거나 업로드한 목소리를
  지울 수 있다(`/v1/audio/voices`는 소유자 개념이 없다). 지워지면 다음 확인(30초 이내)까지는 기본 목소리로 나올 수 있고,
  그 뒤 어댑터가 다시 올린다.
- **NFS 로딩 시간**: 가중치 41.5 GB를 NFS에서 읽는다(측정 25~50초, 약 0.8 GB/s). NFS가 느리거나 끊기면 재시작이 늦어지거나
  실패한다. 이미 떠 있는 엔진은 가중치가 GPU에 있으므로 NFS와 상관없다.
- **터널이 끊기면**: 지금은 Mac `services/tts`가 꺼져 있어서 터널이나 엔진이 없으면 목소리가 아예 없다(앱은 Web Speech,
  전화는 `<Say>`로 넘어간다). 어댑터는 2~5초 안에 `ready:false`가 되고 새 요청에는 503 `loading`을 준다. 말하는 도중이던 스트림은
  거기서 끊긴다. `tunnel.sh`는 ssh가 끝나면 바로(오래 붙어 있었으면 1초, 계속 실패하면 최대 30초 간격) 다시 붙고,
  keepalive(15초 × 3)로 죽은 연결을 약 45초 안에 알아챈다. Mac이 잠들었다 깨면 ssh가 끝날 때까지 최대 45초 동안 503이 날 수
  있다. 엔진이 다시 보이면 어댑터가 목소리 업로드와 워밍업을 다시 한다.
- **GPU 경합**: GPU 5는 이 엔진이 VRAM 62 GB(엔진 0.58 + 코덱 0.08 비율)를 잡아 둔다. 다른 작업이 GPU 5에 올라오면
  메모리가 모자라 그쪽 작업이나 우리 엔진이 OOM 날 수 있다. GPU 0~3의 기존 작업과는 GPU가 달라서 직접 겹치지 않지만 같은
  PCIe·CPU·전력을 쓴다(GPU당 300 W Max-Q). 쉬는 동안 엔진은 GPU 연산을 쓰지 않는다(사용률 0%).
- **디스크**: `/`가 96~97 %다. 이미지 레이어 약 1 GB, `~/mosi-tts/cache` 약 300 MB, 컨테이너 로그(최대 50 MB × 3)가
  더해졌다. `docker builder prune`은 다른 빌드 캐시도 지우므로 쓰지 말 것.
- **SGLang-Omni는 측정만 했다**: 2026-11-14에 GPU 6에서 한 시간 동안 측정했다. 그때 확인한 것은 다음과 같다.
  - `LD_LIBRARY_PATH` 정리를 한 채로 뜬다.
  - sm_120에서는 대체 경로로 돈다.
  - 시작에 353 s가 걸린다.
  - 로그에 텍스트가 없다.
  라이브로 오래 돌린 적은 없다. 워밍업 묶음도 가짜 엔진으로만 시험했다. 엔진에는 vLLM과 마찬가지로 인증이 없으니 루프백에만 연다.
- **엔진 버전**: `vllm-omni==0.32.0`과 `vllm/vllm-openai:v0.32.0`을 고정했다. 이미지를 다시 빌드하면 vllm-omni의 하위 의존성이
  달라질 수 있다.
