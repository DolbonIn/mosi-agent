"""Local Korean TTS for 모시: Fish Audio Drama-3 (MLX 4-bit) kept resident on Apple Silicon.

Listens on 127.0.0.1 only. One request at a time (one GPU); others queue on a lock.

  GET  /health  -> {"ok", "ready", "model", "voices", "sampleRate", "queue", "busyMs"}
                   queue = requests waiting or running; phone calls skip TTS at queue >= 2 (see apps/server phone policy)
  POST /tts     JSON {"text": str (1-600 chars), "voice"?: "pickle", "format"?: "mp3"|"wav",
                      "direction"?: str (acting cue, e.g. "밝고 차분하게")}
                -> audio bytes; headers X-Audio-Duration (s), X-Gen-Ms

Every line clones the voice's reference clip (voices/<voice>.wav + .txt transcript), so the
voice stays the same across lines. Never logs the text.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL_ID = os.environ.get("TTS_MODEL", "mlx-community/fish-audio-drama-3-4bit")
HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "8790"))
VOICE_DIR = Path(os.environ.get("TTS_VOICE_DIR", HERE / "voices"))
MAX_CHARS = 600

state: dict = {"ready": False, "model": None, "frame_rate": 0.0, "queue": 0, "busy_since": None, "last_used": 0.0}
counter = threading.Lock()
gpu = threading.Lock()


def log(msg: str) -> None:
    print(f"[pickle/tts] {msg}", file=sys.stderr, flush=True)


def voices() -> dict[str, tuple[Path, str]]:
    out: dict[str, tuple[Path, str]] = {}
    for wav in sorted(VOICE_DIR.glob("*.wav")):
        txt = wav.with_suffix(".txt")
        if txt.exists():
            out[wav.stem] = (wav, txt.read_text(encoding="utf-8").strip())
    return out


def letters(text: str) -> int:
    return sum(1 for ch in text if unicodedata.category(ch)[0] in "LN")


def spoken(text: str) -> str:
    text = unicodedata.normalize("NFC", text).strip()
    # punctuation-only openings ("…", "!") make Drama-3 miss end-of-speech and babble to the cap
    text = re.sub(r"^[\s\W_]+", "", text)
    # markdown and URLs are not speakable
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[*_`#>|]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def bounds(text: str) -> tuple[float, float]:
    # natural Korean speech is ~0.15-0.25 s per letter; the cap (2x a calm pace) catches babble early
    n = letters(text)
    return max(0.4, 0.07 * n), 2.0 + 0.36 * n


def sentences(text: str) -> list[str]:
    """Split into sentences (., ?, !, …, newlines) and merge fragments under 6 letters into a neighbour.

    One generation per sentence keeps a babbling take (no end-of-speech) to one short retake
    instead of re-running the whole message."""
    raw = [s.strip() for s in re.split(r"(?<=[.?!…。])\s+|\n+", text) if s.strip()]
    out: list[str] = []
    for s in raw:
        if out and (letters(s) < 6 or letters(out[-1]) < 6):
            out[-1] = f"{out[-1]} {s}"
        else:
            out.append(s)
    return out or [text]


def take(model, prompt: str, ref: tuple[Path, str] | None, low: float, high: float):
    import mlx.core as mx
    import numpy as np

    max_tokens = math.ceil(high * state["frame_rate"]) + 4
    best = None
    for attempt in range(3):
        mx.random.seed(int(time.time() * 1000) % 2**31 + attempt)
        kw = {"ref_audio": str(ref[0]), "ref_text": ref[1]} if ref else {}
        parts = list(model.generate(text=prompt, max_tokens=max_tokens, temperature=0.7, top_p=0.7, top_k=30, **kw))
        audio = np.concatenate([np.asarray(p.audio, dtype=np.float32) for p in parts]) if parts else np.zeros(0, np.float32)
        dur = audio.size / model.sample_rate
        if low <= dur < high - 0.05:
            return audio, dur
        # ran to the frame cap (babble) or came out too short: try another seed, keep the closest miss
        if best is None or abs(dur - (low + high) / 2) < abs(best[1] - (low + high) / 2):
            best = (audio, dur)
        log(f"retake {attempt + 1}: {dur:.2f}s outside [{low:.2f}, {high:.2f})")
    assert best is not None
    return best


def synthesize(text: str, voice: str, direction: str | None) -> tuple[bytes, int, float]:
    import numpy as np

    model = state["model"]
    # voice "none" = no reference (used once to design a new reference voice)
    ref = None if voice == "none" else voices()[voice]
    cue = f"[{direction.strip()}] " if direction and direction.strip() else ""
    gap = np.zeros(int(0.22 * model.sample_rate), np.float32)
    chunks = []
    for i, sentence in enumerate(sentences(text)):
        low, high = bounds(sentence)
        audio, _ = take(model, cue + sentence, ref, low, high)
        if i:
            chunks.append(gap)
        chunks.append(audio)
    audio = np.concatenate(chunks)
    return audio_bytes(audio, model.sample_rate), model.sample_rate, audio.size / model.sample_rate


def audio_bytes(audio, sr: int) -> bytes:
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def to_mp3(wav: bytes) -> bytes:
    # -16 LUFS mono 24 kHz: loud enough on a phone line, small enough to fetch fast
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "wav", "-i", "pipe:0", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
         "-ac", "1", "-ar", "24000", "-b:a", "64k", "-f", "mp3", "pipe:1"],
        input=wav, capture_output=True, check=True,
    )
    return proc.stdout


class Handler(BaseHTTPRequestHandler):
    server_version = "pickle-tts/1"

    def log_message(self, fmt: str, *args) -> None:  # no request lines (paths only, but keep it quiet)
        return

    def reply(self, code: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def json(self, code: int, obj: dict) -> None:
        self.reply(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def stream(self, text: str, voice: str, direction: str | None) -> None:
        # HTTP/1.0-style streaming: no Content-Length, the connection closes at the end
        self.send_response(200)
        self.send_header("Content-Type", "audio/L16")
        self.send_header("X-Sample-Rate", str(state["model"].sample_rate))
        self.send_header("X-Channels", "1")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        def write(b: bytes) -> None:
            self.wfile.write(b)
            self.wfile.flush()

        t0 = time.time()
        with counter:
            state["queue"] += 1
        try:
            with gpu:
                state["busy_since"] = time.time()
                try:
                    first, dur = stream_pcm(text, voice, direction, write)
                finally:
                    state["busy_since"] = None
                    state["last_used"] = time.time()
            log(f"stream: {letters(text)} letters, first audio {first * 1000:.0f} ms, {dur:.1f}s audio in {(time.time() - t0) * 1000:.0f} ms")
        except (BrokenPipeError, ConnectionResetError):
            log("stream: client went away")
        except Exception as err:  # noqa: BLE001
            log(f"stream failed: {type(err).__name__}")
        finally:
            with counter:
                state["queue"] -= 1

    def do_GET(self) -> None:
        if self.path != "/health":
            return self.json(404, {"error": "not_found"})
        sr = state["model"].sample_rate if state["model"] else None
        since = state["busy_since"]
        self.json(200, {"ok": True, "ready": state["ready"], "model": MODEL_ID, "voices": sorted(voices()), "sampleRate": sr,
                        "queue": state["queue"], "busyMs": int((time.time() - since) * 1000) if since else 0})

    def do_POST(self) -> None:
        if self.path not in ("/tts", "/tts/stream"):
            return self.json(404, {"error": "not_found"})
        if not state["ready"]:
            return self.json(503, {"error": "loading"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 64_000)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.json(400, {"error": "bad_json"})
        text = spoken(str(body.get("text") or ""))
        voice = str(body.get("voice") or "pickle")
        fmt = str(body.get("format") or "mp3")
        direction = body.get("direction")
        if not text or letters(text) == 0:
            return self.json(400, {"error": "empty_text"})
        if len(text) > MAX_CHARS:
            return self.json(413, {"error": "too_long", "max": MAX_CHARS})
        if voice != "none" and voice not in voices():
            return self.json(400, {"error": "unknown_voice"})
        if fmt not in ("mp3", "wav"):
            return self.json(400, {"error": "bad_format"})
        if self.path == "/tts/stream":
            return self.stream(text, voice, str(direction) if isinstance(direction, str) else None)
        t0 = time.time()
        with counter:
            state["queue"] += 1
        try:
            with gpu:
                state["busy_since"] = time.time()
                try:
                    wav, _sr, dur = synthesize(text, voice, str(direction) if isinstance(direction, str) else None)
                finally:
                    state["busy_since"] = None
                    state["last_used"] = time.time()
            audio = to_mp3(wav) if fmt == "mp3" else wav
        except Exception as err:  # noqa: BLE001 — report, never crash the server
            log(f"synthesis failed: {type(err).__name__}")
            return self.json(500, {"error": "synthesis_failed"})
        finally:
            with counter:
                state["queue"] -= 1
        ms = int((time.time() - t0) * 1000)
        log(f"{letters(text)} letters -> {dur:.1f}s audio in {ms} ms")
        self.reply(200, audio, "audio/mpeg" if fmt == "mp3" else "audio/wav",
                   {"X-Audio-Duration": f"{dur:.2f}", "X-Gen-Ms": str(ms), "Cache-Control": "no-store"})


def stream_pcm(text: str, voice: str, direction: str | None, write) -> tuple[float, float]:
    """Yield-as-you-go synthesis: raw PCM s16le mono at the model rate, ~0.32 s per chunk.

    Returns (seconds to first audio, total audio seconds). No retakes: audio already sent
    can't be taken back, so the per-sentence cap is what bounds a babbling take."""
    import mlx.core as mx
    import numpy as np

    model = state["model"]
    ref = None if voice == "none" else voices()[voice]
    kw = {"ref_audio": str(ref[0]), "ref_text": ref[1]} if ref else {}
    cue = f"[{direction.strip()}] " if direction and direction.strip() else ""
    t0 = time.time()
    first = 0.0
    total = 0
    gap = np.zeros(int(0.22 * model.sample_rate), np.int16).tobytes()
    for i, sentence in enumerate(sentences(text)):
        # no retakes once audio is out, so the stream cap is tighter than bounds(): the reference
        # voice speaks ~0.17 s per letter; 1.0 s + 0.24 s/letter cuts a babbling tail early
        high = 1.0 + 0.24 * letters(sentence)
        mx.random.seed(int(time.time() * 1000) % 2**31)
        if i:
            write(gap)
        for part in model.generate(text=cue + sentence, max_tokens=math.ceil(high * state["frame_rate"]) + 4,
                                   temperature=0.7, top_p=0.7, top_k=30, stream=True, streaming_interval=0.32, **kw):
            pcm = np.clip(np.asarray(part.audio, dtype=np.float32), -1, 1)
            if pcm.size == 0:
                continue
            if not first:
                first = time.time() - t0
            total += pcm.size
            write((pcm * 32767).astype(np.int16).tobytes())
    return first, total / model.sample_rate


def wire(model) -> None:
    """Keep the weights resident. Under memory pressure macOS otherwise pages an idle model out, and the next request
    waits 8-70 s for it to come back. Opt-in (TTS_WIRED=1): measured on this Mac it did NOT stop the paging (70 s after 9 min idle), keep_warm() does."""
    if os.environ.get("TTS_WIRED", "0") != "1":
        return
    import mlx.core as mx
    from mlx.utils import tree_flatten

    weights = sum(v.nbytes for _, v in tree_flatten(model.parameters()))
    cap = int(mx.metal.device_info()["max_recommended_working_set_size"])
    limit = min(cap, int(weights * 1.15) + (2 << 30))
    mx.set_wired_limit(limit)
    log(f"wired limit {limit / 2**30:.1f} GB (weights {weights / 2**30:.1f} GB)")


def keep_warm() -> None:
    """Under memory pressure macOS pages an idle model out within minutes (measured: 4.4 s after 4 min idle, 70 s
    after 9 min, even with a wired limit). A tiny synthesis whenever the model has been idle for TTS_KEEPWARM_S
    (default 20 s; 0 = off) keeps its pages hot: about 0.5 s of GPU per tick, skipped while anything is queued."""
    every = float(os.environ.get("TTS_KEEPWARM_S", "20"))
    if every <= 0:
        return
    while True:
        time.sleep(5)
        if not state["ready"] or state["queue"] or time.time() - state["last_used"] < every:
            continue
        if not gpu.acquire(blocking=False):
            continue
        try:
            t0 = time.time()
            stream_pcm("네.", "pickle", None, lambda _b: None)
            ms = (time.time() - t0) * 1000
            if ms > 3000:
                log(f"keep-warm took {ms:.0f} ms (pages were cold)")
        except Exception as e:  # noqa: BLE001 — never let the warmer die
            log(f"keep-warm failed: {e}")
        finally:
            state["last_used"] = time.time()
            gpu.release()


def load() -> None:
    from mlx_audio.tts.utils import load_model

    t0 = time.time()
    model = load_model(MODEL_ID)
    state["model"] = model
    state["frame_rate"] = model.sample_rate / model.codec.frame_length
    log(f"loaded {MODEL_ID} in {time.time() - t0:.1f}s; voices={sorted(voices())}")
    wire(model)
    # warm-up so the first real request doesn't pay kernel compilation
    with gpu:
        synthesize("네, 알겠어요.", "pickle", None)
        stream_pcm("네, 바로 해 볼게요.", "pickle", None, lambda _b: None)  # compiles the streaming codec path too
    state["ready"] = True
    state["last_used"] = time.time()
    log("ready")
    threading.Thread(target=keep_warm, daemon=True).start()


def main() -> None:
    if not voices():
        sys.exit(f"no voices in {VOICE_DIR} (need <name>.wav + <name>.txt)")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=load, daemon=True).start()
    log(f"listening http://{HOST}:{PORT} (loading model)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
