# services/tts — 모시's local voice (Fish Audio Drama-3)

A small HTTP service that turns Korean text into speech with 모시's own voice. It runs the Fish Audio Drama-3
model (MLX 4-bit build `mlx-community/fish-audio-drama-3-4bit`) on Apple Silicon and keeps it in memory. Every line
clones the same reference clip, so the voice stays the same from line to line. Internal ids keep the old project
name: the voices are `pickle` (the default, brisk) and `pickle-calm` (the first, calmer one), each a
`voices/<id>.wav` clip with its transcript `voices/<id>.txt`.

`apps/server` uses it in these places:

- **`POST /api/tts`** (app call screen): returns `audio/mpeg`, or 503 `tts_unavailable` so the client can fall back
  to Web Speech. See `docs/architecture/SERVER-CONTRACT.md` → "Voice".
- **`POST /api/tts/stream`** (app call screen, real time): proxies `/tts/stream` as it decodes, halved to 22.05 kHz
  s16le mono, and cancels the upstream request when the client hangs up. Refused with 503 when `queue` ≥ 2.
- **Twilio calls** (`sys_phone_call`, `sys_call_me`, phone-number verification): the message is synthesized before
  dialling and Twilio plays it with `<Play>` from a public 15-minute token URL. If TTS or the public URL isn't
  available, the service is busy, or the voice takes longer than 45 s, the call uses `<Say language="ko-KR">`
  instead.

## Setup

Needs macOS on Apple Silicon, [uv](https://docs.astral.sh/uv/), Python 3.12 (uv installs it) and `ffmpeg` on `PATH`
(for mp3 encoding).

```sh
services/tts/setup.sh   # once: creates .venv, installs mlx-audio (pinned commit), downloads ~22 GB of weights
services/tts/start.sh   # serves http://127.0.0.1:8790; loading plus warm-up takes about 15 s
```

`start.sh` runs offline (`HF_HUB_OFFLINE=1`) once the weights are cached. Environment overrides: `TTS_PORT` (8790),
`TTS_HOST` (127.0.0.1), `TTS_MODEL`, `TTS_VOICE_DIR`, `TTS_PYTHON`. To add a voice, put `<name>.wav` and
`<name>.txt` (what the clip says) in `voices/`. The special voice `none` uses no reference clip; it is for designing
a new reference voice (generate a line, keep the take you like as the new clip).

The service listens on 127.0.0.1 only. Don't expose it: it has no auth.

## Contract

| Request | Response |
|---|---|
| `GET /health` | `{"ok":true,"ready":bool,"model":"…","voices":["pickle","pickle-calm"],"sampleRate":44100,"queue":n,"busyMs":n}`; `ready` is false while loading; `queue` counts lines waiting or running, `busyMs` how long the current one has run |
| `POST /tts` JSON `{"text": 1–600 chars, "voice"?: "pickle", "format"?: "mp3"\|"wav", "direction"?: "acting cue"}` | audio bytes: `audio/mpeg` by default (mono 24 kHz, 64 kbps, loudness −16 LUFS) or `audio/wav`; headers `X-Audio-Duration` (seconds), `X-Gen-Ms` |
| `POST /tts/stream` (same JSON body) | raw PCM as it decodes: `audio/L16`, **s16le** mono at `X-Sample-Rate` (44100), ~0.32 s chunks, no `Content-Length`; the connection closes at the end. No retakes (audio already sent can't be taken back), so a tighter per-sentence cap (1.0 s + 0.24 s per letter) is what bounds babble. The streaming path is warmed up at boot, so the first stream after a restart also starts in ~0.25 s |

- `voice` is a name from `voices`, or `none` (no reference).
- `direction` is an acting cue placed in front of each sentence, e.g. `"밝고 차분하게"`.
- The text is cleaned before speaking: markdown symbols, URLs and leading punctuation are dropped.
- Errors are JSON `{"error": …}`: 400 `bad_json` / `empty_text` / `unknown_voice` / `bad_format`, 413 `too_long`,
  503 `loading`, 500 `synthesis_failed`, 404 `not_found`.
- The service never logs the text, only letter counts and timings.

### How the server (apps/server) uses it

- `PICKLE_TTS_URL`: default `http://127.0.0.1:8790`; `off` disables TTS.
- Lines are cached at `${PICKLE_DATA_DIR}/tts/<sha256(voice|direction|text)>.mp3`, pruned oldest-first past 300
  files or 150 MB. Concurrent requests for the same line share one synthesis. `/api/tts` waits 20 s plus 1.5 s per
  10 characters, capped at 150 s; a caller that gives up doesn't cancel the line, which still lands in the cache.
- Phone calls check `/health` first: with `queue` ≥ 2 they skip TTS and use `<Say>` at once; otherwise they wait at
  most 45 s for the voice. A line already in the cache plays even when the service is busy.
- Twilio audio is served by a separate listener on `127.0.0.1:${PICKLE_AUDIO_PORT:-8789}`. It answers only
  `GET /a/<32 hex>.mp3` for tokens registered in the last 15 minutes; everything else is 404. The public base URL is
  `PICKLE_PUBLIC_AUDIO_URL` if set. Otherwise, when Twilio and TTS are both configured (and `PICKLE_AUDIO_TUNNEL`
  isn't `0`), the server starts a Cloudflare quick tunnel (`cloudflared tunnel --url …`) and stops it on shutdown.
  `CLOUDFLARED_BIN` overrides the binary path.
- `/api/health` reports `tts: "configured"|"missing"` and `publicAudio: "ready"|"missing"`.

## Memory and speed

- **Memory:** about 28 GB of unified memory at peak while generating. Verified on an M3 Max with 48 GB; leave that
  much free before starting it.
- **Speed:** roughly real time, e.g. 8.4 s of audio in 7.6 s on the M3 Max. Text is generated one sentence at a time
  (fragments under 6 letters are merged into a neighbour) and joined with a short pause. A sentence that comes out
  too short or runs past its cap (2.0 s + 0.36 s per letter, the sign of babbling) is retaken, up to 3 takes, so an
  unlucky sentence takes two or three times longer, but only that sentence.
- **One line at a time:** a single GPU lock serializes requests; the others wait in line. A call screen should
  request each sentence as soon as it's final rather than one long paragraph.

## License

The model weights are licensed under the **Fish Audio Community License** (v1.0, 2026-10-13), not an open-source
license. The full text ships with the weights (`LICENSE` and `NOTICE` in the Hugging Face cache for
`mlx-community/fish-audio-drama-3-4bit`).

**For this project, treat the voice as research and non-commercial use only.** The license allows research and
non-commercial use free of charge. It allows commercial use only within narrow limits (under USD 500,000 annual
revenue, and never as a hosted text-to-speech service for third parties); anything beyond that needs a separate
written license from Fish Audio (business@fish.audio). Get that license checked before any commercial launch.

The license also requires, among other things:

- **Attribution:** a product that uses the model must show "Built with Fish Audio" somewhere prominent (website,
  about page or docs).
- **No voice imitation without consent:** don't clone an identifiable person's voice without their permission.
  The `pickle` reference clip must be a voice we have the right to use.
- **No deceptive or illegal calls:** don't impersonate people or organizations, and don't place calls that break
  telemarketing or robocall laws.
- **No training other speech models** on the model or its output.

The inference library, `mlx-audio`, is MIT-licensed.

## 메모리 압박에서 지연 막기

이 Mac은 스왑을 23~26 GB씩 쓰는 상태라, 쉬고 있는 모델 가중치(22.4 GB)가 몇 분 만에 디스크로 밀려나면 다음 요청의 첫 소리가
8~70초로 늘어난다(2026-11-11 측정). 그래서 서버는 모델이 `TTS_KEEPWARM_S`초(기본 20, 0이면 끔) 동안 놀면 "네." 한 마디를 몰래
만들어 페이지를 데워 둔다. 대기열에 요청이 있으면 건너뛴다. 로그의 `keep-warm took … ms (pages were cold)`가 자주 보이면 메모리가
그만큼 부족하다는 뜻이다. `TTS_WIRED=1`(MLX wired limit)도 있지만 이 Mac에서는 밀려나는 것을 막지 못했다(9분 뒤 70초).
