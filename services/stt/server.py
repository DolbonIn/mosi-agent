"""Local Korean speech-to-text for 모시: Whisper large-v3-turbo on MLX (mlx-whisper), kept resident.

Listens on 127.0.0.1 only. One transcription at a time inside this process (a lock); others queue.
Runs fine next to services/tts (Drama-3) on the same GPU, as a separate process.

  GET  /health          -> {"ok", "ready", "model", "queue"}
  POST /stt?lang=ko     body: raw PCM s16le, 16 kHz, mono (Content-Type: audio/L16; rate=16000), at most 30 s
                        -> {"text", "ms", "durationMs", "noSpeech"}
                        400 empty_body / too_long / bad_rate, 503 loading, 500 transcription_failed

Silence and noise often come back from Whisper as stock phrases ("시청해 주셔서 감사합니다", "구독과 좋아요"...).
Those, near-silent or unpitched input (noise) and low-confidence segments return {"text": "", "noSpeech": true}.
Never logs the transcript: only durations, lengths and timings.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MODEL_ID = os.environ.get("STT_MODEL", "mlx-community/whisper-large-v3-turbo")
HOST = os.environ.get("STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("STT_PORT", "8782"))
RATE = 16_000
MAX_SECONDS = 30
MAX_BYTES = RATE * 2 * MAX_SECONDS

# a segment is dropped when Whisper itself thinks it is probably not speech and isn't confident in the words
NO_SPEECH_PROB = float(os.environ.get("STT_NO_SPEECH_PROB", "0.6"))
MIN_AVG_LOGPROB = float(os.environ.get("STT_MIN_AVG_LOGPROB", "-1.0"))
# repetitive output ("네 네 네 네 …") compresses well: a sign of a decoding loop
MAX_COMPRESSION = float(os.environ.get("STT_MAX_COMPRESSION", "2.4"))
# below this RMS (dBFS) the input is treated as silence without running the model
SILENCE_DBFS = float(os.environ.get("STT_SILENCE_DBFS", "-50"))
# whisper-large-v3-turbo reports no_speech_prob ≈ 0 even for pure noise and answers "감사합니다." to hiss,
# so a cheap periodicity check runs first: speech has voiced (pitched) frames, noise doesn't.
# Measured: clean/noisy/Opus speech 0.64–0.69 of frames voiced, white/pink/brown noise 0.00.
MIN_VOICED_RATIO = float(os.environ.get("STT_MIN_VOICED_RATIO", "0.05"))
MIN_VOICED_MS = int(os.environ.get("STT_MIN_VOICED_MS", "120"))

# Whisper's well-known Korean hallucinations on silence/noise (YouTube sign-offs and subtitle credits).
# Compared after normalizing (lowercase, no spaces or punctuation). A whole utterance or segment that is one of
# these (or repeats of one) is dropped; real sentences that merely contain the words are kept.
HALLUCINATIONS = [
    "시청해 주셔서 감사합니다",
    "시청해 주셔서 고맙습니다",
    "오늘도 시청해 주셔서 감사합니다",
    "영상 끝까지 시청해 주셔서 감사합니다",
    "끝까지 봐주셔서 감사합니다",
    "구독과 좋아요",
    "구독과 좋아요 부탁드립니다",
    "구독 좋아요",
    "좋아요와 구독",
    "구독 좋아요 알림 설정",
    "구독과 좋아요 그리고 알림 설정 부탁드립니다",
    "감사합니다 구독",
    "다음 영상에서 만나요",
    "다음 영상에서 뵙겠습니다",
    "다음 시간에 만나요",
    "Thank you for watching",
    "Thanks for watching",
]
HALLUCINATION_PATTERNS = [
    r"(한글|번역)?자막(제공|제작|by).{0,20}",
    r"subtitlesby.{0,20}",
    r"(mbc|kbs|sbs|ytn|jtbc)뉴스[가-힣]{2,4}입니다",
]

state: dict = {"ready": False, "queue": 0}
gpu = threading.Lock()
counter = threading.Lock()


def log(msg: str) -> None:
    print(f"[pickle/stt] {msg}", file=sys.stderr, flush=True)


def norm(text: str) -> str:
    text = unicodedata.normalize("NFC", text).lower()
    return re.sub(r"[\s\W_]+", "", text)


_HALLU = {norm(h) for h in HALLUCINATIONS}
_HALLU_RE = [re.compile(f"^(?:{p})$") for p in HALLUCINATION_PATTERNS]


def is_hallucination(text: str) -> bool:
    n = norm(text)
    if not n:
        return True
    if n in _HALLU or any(r.match(n) for r in _HALLU_RE):
        return True
    # "시청해 주셔서 감사합니다 시청해 주셔서 감사합니다"
    return any(len(n) % len(h) == 0 and n == h * (len(n) // len(h)) for h in _HALLU)


def voiced(audio) -> tuple[float, int]:
    """(share of 40 ms frames that are pitched 60–400 Hz, voiced milliseconds). Pre-emphasis whitens rumble;
    a steady tone (beeps, hum: the same pitch in every frame) counts as unvoiced."""
    import numpy as np

    n, hop = 640, 320
    if audio.size < n:
        return 0.0, 0
    x = np.append(audio[:1], audio[1:] - 0.97 * audio[:-1])
    k = 1 + (x.size - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(k)[:, None]
    fr = x[idx] * np.hanning(n)[None, :]
    fr = fr - fr.mean(axis=1, keepdims=True)
    energy = np.sum(fr * fr, axis=1)
    ac = np.fft.irfft(np.abs(np.fft.rfft(fr, 2 * n, axis=1)) ** 2, axis=1)[:, :n]
    ac = ac / np.maximum(ac[:, :1], 1e-12)
    band = ac[:, RATE // 400 : RATE // 60]
    peak = band.max(axis=1)
    loud = energy > max(1e-9, float(energy.max()) * 10 ** (-35 / 10))
    mask = (peak > 0.5) & loud
    v = int(np.count_nonzero(mask))
    if v >= 10 and float(np.std(band.argmax(axis=1)[mask])) < 1.0:
        return 0.0, 0
    return v / k, v * hop * 1000 // RATE


def speechless(audio) -> bool:
    """True when the clip is silence or unpitched noise (the model isn't run)."""
    import numpy as np

    rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
    if rms <= 0 or 20 * np.log10(rms) < SILENCE_DBFS:
        return True
    ratio, ms = voiced(audio)
    return ratio < MIN_VOICED_RATIO or ms < MIN_VOICED_MS


# Whisper hears the short name "모시야" as "5시야", "모시자", "무시아" without context (live Meet test, 2026-11-12).
# An initial prompt that contains the name biases decoding toward it. `?prompt=…` overrides it per request (the meet
# bot passes the user's own agent name); an empty `?prompt=` or STT_PROMPT="" turns it off.
DEFAULT_PROMPT = os.environ.get("STT_PROMPT", "모시야, 지금 회의 내용 좀 정리해 줄래?")


# Korean speech runs at most ~9 syllables a second; more text than that for the audio can't have been said.
MAX_SYLLABLES_PER_S = 9.0


def is_prompt_echo(text: str, prompt: str | None, duration_s: float) -> bool:
    """On short, unclear audio Whisper can return its prompt verbatim; that would read as someone calling 모시.
    Only text that matches the prompt AND is too long for the audio is dropped: someone really saying the prompt
    sentence ("모시야, 지금 회의 내용 좀 정리해 줄래?" takes 2–3 s) is kept."""
    if not prompt:
        return False
    n, p = norm(text), norm(prompt)
    if not n or not (n == p or (len(n) >= 8 and n in p)):
        return False
    return len(n) > duration_s * MAX_SYLLABLES_PER_S


def transcribe(audio, lang: str, prompt: str | None = None) -> tuple[str, bool]:
    """(text, noSpeech). `audio`: float32 numpy in [-1, 1] at 16 kHz."""
    import mlx_whisper

    duration_s = audio.size / RATE

    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=MODEL_ID,
        language=lang,
        initial_prompt=prompt or None,
        task="transcribe",
        condition_on_previous_text=False,
        temperature=(0.0, 0.2, 0.4),
        compression_ratio_threshold=MAX_COMPRESSION,
        logprob_threshold=MIN_AVG_LOGPROB,
        no_speech_threshold=NO_SPEECH_PROB,
        verbose=None,
    )
    kept: list[str] = []
    for seg in result.get("segments") or []:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        nsp = float(seg.get("no_speech_prob") or 0.0)
        alp = float(seg.get("avg_logprob") or 0.0)
        cr = float(seg.get("compression_ratio") or 0.0)
        if nsp > NO_SPEECH_PROB and alp < MIN_AVG_LOGPROB:
            continue
        if cr > MAX_COMPRESSION:
            continue
        if is_hallucination(text) or is_prompt_echo(text, prompt, duration_s):
            continue
        kept.append(text)
    text = re.sub(r"\s+", " ", " ".join(kept)).strip()
    if not text or is_hallucination(text) or is_prompt_echo(text, prompt, duration_s):
        return "", True
    return text, False


class Handler(BaseHTTPRequestHandler):
    server_version = "pickle-stt/1"

    def log_message(self, fmt: str, *args) -> None:  # no request lines
        return

    def json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if urlparse(self.path).path != "/health":
            return self.json(404, {"error": "not_found"})
        self.json(200, {"ok": True, "ready": state["ready"], "model": MODEL_ID, "queue": state["queue"]})

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if url.path != "/stt":
            return self.json(404, {"error": "not_found"})
        q = parse_qs(url.query, keep_blank_values=True)
        lang = (q.get("lang") or ["ko"])[0][:8] or "ko"
        # `?prompt=` absent → the default; present (even empty) → exactly that, at most 200 chars. Never logged.
        prompt = (q.get("prompt") or [None])[0]
        prompt = DEFAULT_PROMPT if prompt is None else prompt[:200]
        ctype = self.headers.get("Content-Type") or ""
        m = re.search(r"rate=(\d+)", ctype)
        if m and int(m.group(1)) != RATE:
            return self.json(400, {"error": "bad_rate", "rate": RATE})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self.json(400, {"error": "empty_body"})
        if length > MAX_BYTES:
            return self.json(400, {"error": "too_long", "maxSeconds": MAX_SECONDS})
        raw = self.rfile.read(length)
        if not state["ready"]:
            return self.json(503, {"error": "loading"})
        import numpy as np

        raw = raw[: len(raw) - (len(raw) % 2)]
        if not raw:
            return self.json(400, {"error": "empty_body"})
        audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        duration_ms = int(audio.size * 1000 / RATE)
        t0 = time.time()
        if speechless(audio):
            ms = int((time.time() - t0) * 1000)
            log(f"{duration_ms} ms audio -> no speech (gate) in {ms} ms")
            return self.json(200, {"text": "", "ms": ms, "durationMs": duration_ms, "noSpeech": True})
        with counter:
            state["queue"] += 1
        try:
            with gpu:
                text, no_speech = transcribe(audio, lang, prompt)
        except Exception as err:  # noqa: BLE001 — report, never crash the server
            log(f"transcription failed: {type(err).__name__}")
            return self.json(500, {"error": "transcription_failed"})
        finally:
            with counter:
                state["queue"] -= 1
        ms = int((time.time() - t0) * 1000)
        log(f"{duration_ms} ms audio -> {len(text)} chars{' (no speech)' if no_speech else ''} in {ms} ms")
        self.json(200, {"text": text, "ms": ms, "durationMs": duration_ms, "noSpeech": no_speech})


def load() -> None:
    import numpy as np

    t0 = time.time()
    with gpu:
        # first call loads the weights and compiles kernels; a quiet tone gets past the silence gate
        t = np.arange(RATE, dtype=np.float32) / RATE
        warm = (0.05 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        try:
            transcribe(warm, "ko", DEFAULT_PROMPT)
        except Exception as err:  # noqa: BLE001
            log(f"warm-up failed: {type(err).__name__}: {err}")
            os._exit(1)
    state["ready"] = True
    log(f"ready: {MODEL_ID} loaded and warmed up in {time.time() - t0:.1f}s")


def main() -> None:
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=load, daemon=True).start()
    log(f"listening http://{HOST}:{PORT} (loading model)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
