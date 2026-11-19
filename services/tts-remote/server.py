"""모시 TTS on the company GPU box, served on the Mac with the same HTTP API as services/tts.

Fish Audio Drama-3 runs under vLLM-Omni (gpu/run-engine.sh) or SGLang-Omni (gpu/run-sglang.sh) on the GPU box; set
TTS_ENGINE_KIND=vllm|sglang (default vllm) to match. An SSH tunnel brings the engine's port to the Mac (tunnel.sh:
127.0.0.1:8795 -> GPU box). This adapter listens on 127.0.0.1:8794 and speaks the services/tts contract, so apps/server
and services/meet only change a URL:

  GET  /health       -> {"ok", "ready", "model", "voices", "sampleRate", "queue", "busyMs",
                         + "inflight", "slots", "backend", "warming"}
  POST /tts          JSON {"text": 1-600 chars, "voice"?: "pickle", "format"?: "mp3"|"wav", "direction"?: str}
                     -> audio bytes; headers X-Audio-Duration (s), X-Gen-Ms
  POST /tts/stream   same body -> raw s16le mono PCM at X-Sample-Rate (44100) as the engine decodes it

The engine batches: up to `slots` engine lines (one sentence each) run side by side. `queue` keeps its Mac meaning,
how many lines a new request would wait behind (0 = it starts at once): lines waiting for a slot, plus one when every
slot is taken. `inflight` counts requests.

With SGLang-Omni, `ready` turns true only after warm-up bursts (TTS_WARM_BURSTS, default 4,8,12,16 lines at once):
the engine compiles kernels the first time it sees a batch size, and on 2026-11-14 that cost the first lines at a new
size 1.1-1.6 s to first audio. Then a staggered warm-up (TTS_WARM_LEVELS, default 2,4,8,12,16 lines kept going at
once, TTS_WARM_LEVEL_S 14 s each): real calls add one new line to lines already speaking, a shape the bursts never
make, and after the bursts alone the engine still ran cold under real traffic on 2026-11-15. Until then requests get
503 loading, as while the engine loads; `warming` is true while the warm-up runs. A short engine outage (under
TTS_REWARM_AFTER_S, 60 s: a tunnel hiccup, not a restart, which takes about 6 min) does not repeat it.

Whether the engine is up comes from a probe thread (GET /health every 2 s, TTS_PROBE_TIMEOUT_S 5 s) and from the
engine lines themselves; requests never probe. Under load SGLang-Omni's /health answered slower than the old 1.5 s
timeout and the adapter turned 69 calls away as `loading` on 2026-11-15 while every stream was fine. So the engine
counts as unreachable only after TTS_PROBE_FAILS (3) failed probes in a row, or at once when a line cannot connect to
it; a line the engine answers (200) counts as a passed probe.

Stdlib only (runs with any python3 >= 3.10). Never logs the text, only letter counts and timings.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
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
import wave
from array import array
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "8794"))
ENGINE = os.environ.get("TTS_ENGINE", "127.0.0.1:8795")  # the SSH tunnel's local end
# Which server is behind ENGINE. Both speak the same OpenAI-style speech + voice-upload API; they differ only in how a
# line names a voice that is not uploaded (see Take.open) and in the /health label.
ENGINE_KIND = os.environ.get("TTS_ENGINE_KIND", "vllm").strip().lower()
if ENGINE_KIND not in ("vllm", "sglang"):
    raise SystemExit(f"TTS_ENGINE_KIND must be vllm or sglang, got {ENGINE_KIND!r}")
ENGINE_LABEL = {"vllm": "vllm-omni", "sglang": "sglang-omni"}[ENGINE_KIND]
ENGINE_VOICE_DIR = os.environ.get("TTS_ENGINE_VOICE_DIR", "/voices")  # where the GPU box mounts voices/ in the engine
VOICE_DIR = Path(os.environ.get("TTS_VOICE_DIR", HERE.parent / "tts" / "voices"))
# Engine lines at once. vLLM-Omni runs up to 16 (max_num_seqs): 12 keeps 4 spare. SGLang-Omni (max_running 32) kept TTFA
# p95 <= 300 ms with RTF p95 <= 0.6 up to 11 at once on one RTX PRO 6000 (2026-11-14, README "SGLang-Omni 엔진"): 11.
SLOTS = max(1, int(os.environ.get("TTS_SLOTS", "11" if ENGINE_KIND == "sglang" else "12")))
# SGLang-Omni only: concurrent warm-up bursts before reporting ready (sizes, comma-separated; "" turns them off;
# sizes below 1 are dropped)
WARM_BURSTS = [n for n in (int(x) for x in os.environ.get("TTS_WARM_BURSTS", "4,8,12,16").split(",") if x.strip())
               if n > 0] if ENGINE_KIND == "sglang" else []
REWARM_AFTER_S = float(os.environ.get("TTS_REWARM_AFTER_S", "60"))  # outage that repeats them (a restart takes ~6 min)
# SGLang-Omni only: then each of these many lines kept going at once (closed loop, staggered starts) for WARM_LEVEL_S
WARM_LEVELS = [n for n in (int(x) for x in os.environ.get("TTS_WARM_LEVELS", "2,4,8,12,16").split(",") if x.strip())
               if n > 0] if ENGINE_KIND == "sglang" else []
WARM_LEVEL_S = float(os.environ.get("TTS_WARM_LEVEL_S", "14"))
WARMS = bool(WARM_BURSTS or WARM_LEVELS)  # anything to do before ready
PROBE_TIMEOUT_S = float(os.environ.get("TTS_PROBE_TIMEOUT_S", "5"))  # GET /health; under load it took over 1.5 s
PROBE_FAILS = max(1, int(os.environ.get("TTS_PROBE_FAILS", "3")))  # failed probes in a row that mean unreachable
PROBE_EVERY_S = 2.0
PROBE_SLOW_S = 1.5  # probes slower than this are counted and logged (numbers only), once every 30 s at most
WARM_LINES = ["네, 확인해 볼게요.", "지금 바로 일정 잡아 드릴까요?", "내일 오후 세 시에 회의가 하나 있어요.",
              "보내 주신 자료는 방금 다 읽어 봤어요.", "회의 끝나면 오늘 정리한 내용을 메일로 보내 드릴게요.",
              "그럼 다음 주 화요일 오전으로 다시 잡아 둘까요?"]  # fixed text, the lengths of a spoken reply's sentences
MODEL_ID = "fishaudio/drama-3"
SAMPLE_RATE = 44100
FRAME_RATE = SAMPLE_RATE / 2048  # Drama-3 codec frames per second (21.5)
MAX_CHARS = 600
GAP_S = 0.22  # pause between sentences, as on the Mac
# babble guard: Drama-3 sometimes stops talking and emits silence until max_new_tokens. A take whose audio stays
# below SILENT_PEAK for SILENCE_CUT_S after speech (or LEAD_CUT_S before any speech) is cut there.
SILENT_PEAK = int(os.environ.get("TTS_SILENT_PEAK", "300"))  # of 32767, about -40 dBFS
SILENCE_CUT_S = float(os.environ.get("TTS_SILENCE_CUT_S", "1.2"))
LEAD_CUT_S = float(os.environ.get("TTS_LEAD_CUT_S", "1.5"))
KEEP_TAIL_S = 0.25  # silence passed on at once after speech; a cut take ends with this much
ENGINE_ERRORS = (OSError, http.client.HTTPException)  # timeouts and resets are OSError; bad replies HTTPException

# ready: the engine answers (see engine_seen); warm: the warm-up is done (always true without one); warm_gen: which
# warm-up may set it (the latest); down_since: when the engine last became unreachable (its first failed probe);
# fails / fail_since: failed probes in a row and when the first of them was
state = {"inflight": 0, "starts": {}, "ready": False, "checked": 0.0, "warm": not WARMS, "warm_gen": 0,
         "warming": False, "down_since": None, "fails": 0, "fail_since": None}
lock = threading.Lock()
probe_now = threading.Event()  # a line failed in a way that is not proof the engine is gone: probe again at once
engine_voice: dict[str, str] = {}  # our voice id -> the engine's uploaded voice name (see sync_voices)
clip_b64: dict[str, tuple[float, str]] = {}  # voice id -> (wav mtime, base64 wav), for SGLang's inline references
sync_lock = threading.Lock()
warm_lock = threading.Lock()


def log(msg: str) -> None:
    print(f"[mosi/tts-remote] {time.strftime('%H:%M:%S')} {msg}", file=sys.stderr, flush=True)


# ───────────────────────────── text (same rules as services/tts) ─────────────────────────────


def voices() -> dict[str, str]:
    out: dict[str, str] = {}
    for wav in sorted(VOICE_DIR.glob("*.wav")):
        txt = wav.with_suffix(".txt")
        if txt.exists():
            out[wav.stem] = txt.read_text(encoding="utf-8").strip()
    return out


def letters(text: str) -> int:
    return sum(1 for ch in text if unicodedata.category(ch)[0] in "LN")


def spoken(text: str) -> str:
    text = unicodedata.normalize("NFC", text).strip()
    text = re.sub(r"^[\s\W_]+", "", text)  # punctuation-only openings make Drama-3 miss end-of-speech
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"[*_`#>|]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


def sentences(text: str) -> list[str]:
    raw = [s.strip() for s in re.split(r"(?<=[.?!…。])\s+|\n+", text) if s.strip()]
    out: list[str] = []
    for s in raw:
        if out and (letters(s) < 6 or letters(out[-1]) < 6):
            out[-1] = f"{out[-1]} {s}"
        else:
            out.append(s)
    return out or [text]


def bounds(text: str) -> tuple[float, float]:
    """Acceptable take length for /tts (retakes outside it), as on the Mac."""
    n = letters(text)
    return max(0.4, 0.07 * n), 2.0 + 0.36 * n


def stream_cap(text: str) -> float:
    """Longest take for /tts/stream (no retakes once audio is out), as on the Mac."""
    return 1.0 + 0.24 * letters(text)


# ───────────────────────────── engine lines ─────────────────────────────


class Slots:
    """At most SLOTS engine lines at once; the rest wait here (that wait is what /health reports as queue)."""

    def __init__(self, n: int):
        self.n, self.running, self.waiting = n, 0, 0
        self.cv = threading.Condition()

    def acquire(self) -> None:
        with self.cv:
            self.waiting += 1
            while self.running >= self.n:
                self.cv.wait()
            self.waiting -= 1
            self.running += 1

    def release(self) -> None:
        with self.cv:
            self.running -= 1
            self.cv.notify()

    def queue(self) -> int:
        with self.cv:
            return self.waiting + (1 if self.running >= self.n else 0)


slots = Slots(SLOTS)


class EngineDown(Exception):
    pass


def engine_conn(timeout: float) -> http.client.HTTPConnection:
    host, _, port = ENGINE.rpartition(":")
    return http.client.HTTPConnection(host or "127.0.0.1", int(port), timeout=timeout)


def probe_engine() -> bool:
    """One GET /health on the engine. Only the watcher thread calls it."""
    try:
        c = engine_conn(PROBE_TIMEOUT_S)
        try:
            c.request("GET", "/health")
            r = c.getresponse()
            r.read()
            return r.status == 200
        finally:
            c.close()
    except ENGINE_ERRORS:
        return False


def engine_seen(ok: bool, hard: bool = False, why: str = "") -> None:
    """One sighting of the engine: a probe, or an engine line (a 200 means it answers; a line that cannot connect, `hard`,
    means it is gone). Unreachable after PROBE_FAILS failed probes in a row or one hard failure; any answer resets the
    count, so a slow /health under load never turns calls away while lines are getting through. Coming back starts the
    warm-up: voices, and (SGLang-Omni, after a start or a long outage) the gated warm-up."""
    now = time.time()
    with lock:
        if ok:
            state["fails"], state["fail_since"] = 0, None
        else:
            state["fails"] += 1
            state["fail_since"] = state["fail_since"] or now
        was = state["ready"]
        up = True if ok else (False if hard or state["fails"] >= PROBE_FAILS else was)
        came_up = up and not was
        if up != was:
            log(f"engine {'ready' if up else 'unreachable'} at {ENGINE}{'' if up else f' ({why})'}")
        if was and not up:
            state["down_since"] = state["fail_since"] or now
        gen = 0  # 0: no gated warm-up this time
        if came_up and WARMS:
            down = state["down_since"]
            # a restart takes minutes, so an engine back within REWARM_AFTER_S still has its kernels compiled
            if not state["warm"] or down is None or now - down >= REWARM_AFTER_S:
                state["warm_gen"] += 1
                state["warm"], gen = False, state["warm_gen"]
        state["ready"], state["checked"] = up, now
    if came_up:
        threading.Thread(target=warm_up, args=(gen,), daemon=True).start()


def engine_ready() -> bool:
    """The engine answers, as last seen by the watcher or an engine line (never probes: a probe can take seconds)."""
    return state["ready"]


def serving_ready() -> bool:
    """What /health reports and requests wait for: the engine answers, and (SGLang-Omni) its warm-up is done."""
    return state["ready"] and state["warm"]


voice_check_lock = threading.Lock()


def check_voices_bg() -> None:
    if not voice_check_lock.acquire(blocking=False):
        return
    try:
        check_voices()
    except Exception as err:  # noqa: BLE001
        log(f"voice check failed: {type(err).__name__}")
    finally:
        voice_check_lock.release()


def watch_engine() -> None:
    """Probe the engine every 2 s (at once after a line failed without proof the engine is gone) so /health and
    requests read a fresh answer without waiting on the tunnel; every ~30 s also check, off this thread, that our
    uploaded voices are still there. Probes over PROBE_SLOW_S are counted and logged at most every 30 s."""
    n, slow, slow_max, slow_t = 0, 0, 0.0, time.time()
    while True:
        try:
            t0 = time.time()
            ok = probe_engine()
            took = time.time() - t0
            if took > PROBE_SLOW_S:
                slow, slow_max = slow + 1, max(slow_max, took)
            if slow and time.time() - slow_t >= 30:
                log(f"engine /health slow: {slow} probes over {PROBE_SLOW_S:g} s in the last "
                    f"{time.time() - slow_t:.0f} s, max {slow_max * 1000:.0f} ms")
                slow, slow_max, slow_t = 0, 0.0, time.time()
            elif not slow:
                slow_t = time.time()
            engine_seen(ok, why=f"{PROBE_FAILS} probes failed in a row")
            if ok and n % 15 == 14:
                threading.Thread(target=check_voices_bg, daemon=True).start()
        except Exception as err:  # noqa: BLE001 — never let the watcher die
            log(f"engine probe failed: {type(err).__name__}")
        n += 1
        probe_now.wait(PROBE_EVERY_S)
        probe_now.clear()


def engine_json(method: str, path: str, body: bytes | None = None, ctype: str = "application/json") -> tuple[int, dict]:
    c = engine_conn(30)
    try:
        c.request(method, path, body, {"Content-Type": ctype} if body is not None else {})
        r = c.getresponse()
        raw = r.read()
        try:
            return r.status, json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return r.status, {}
    finally:
        c.close()


def voice_tag(voice: str) -> str:
    """Engine-side name of a voice: changes whenever its clip or transcript changes, so an edit re-uploads it."""
    digest = hashlib.sha256((VOICE_DIR / f"{voice}.wav").read_bytes() + voices()[voice].encode()).hexdigest()[:10]
    return f"mosi-{voice}-{digest}"


def voice_clip_b64(voice: str) -> str:
    wav = VOICE_DIR / f"{voice}.wav"
    mtime = wav.stat().st_mtime
    cached = clip_b64.get(voice)
    if cached is None or cached[0] != mtime:
        cached = clip_b64[voice] = (mtime, base64.b64encode(wav.read_bytes()).decode("ascii"))
    return cached[1]


def uploaded_names() -> set[str] | None:
    status, listing = engine_json("GET", "/v1/audio/voices")
    if status != 200:
        return None
    return {v.get("name") for v in listing.get("uploaded_voices", []) if isinstance(v, dict)}


def sync_voices() -> None:
    """Upload each voice clip to the engine once (POST /v1/audio/voices). The engine keeps an uploaded voice's encoded
    reference in memory (and the upload on disk), so a line skips re-encoding the clip: ~50-70 ms less to first audio
    than sending the clip as ref_audio. Until a voice is uploaded, lines send it as file:///voices/<id>.wav (vLLM-Omni)
    or inline as base64 (SGLang-Omni).
    One sync at a time; a caller arriving during a sync just returns."""
    if not sync_lock.acquire(blocking=False):
        return
    try:
        have = uploaded_names()
        if have is None:
            log("voice sync: listing failed")
            return
        for voice, transcript in voices().items():
            tag = voice_tag(voice)
            if tag not in have:
                engine_voice.pop(voice, None)
                boundary = f"mosi{time.time_ns()}"
                fields = [("name", tag), ("consent", "mosi-own-voice"), ("ref_text", transcript)]
                body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                                for k, v in fields)
                body += (f'--{boundary}\r\nContent-Disposition: form-data; name="audio_sample"; filename="{voice}.wav"\r\n'
                         "Content-Type: audio/wav\r\n\r\n").encode() + (VOICE_DIR / f"{voice}.wav").read_bytes()
                body += f"\r\n--{boundary}--\r\n".encode()
                status, _ = engine_json("POST", "/v1/audio/voices", body, f"multipart/form-data; boundary={boundary}")
                if status != 200:
                    log(f"voice sync: upload of {voice} failed ({status})")
                    continue
                log(f"voice sync: uploaded {voice} as {tag}")
            engine_voice[voice] = tag
            for old in have:  # earlier versions of this voice
                if isinstance(old, str) and old != tag and re.fullmatch(rf"mosi-{re.escape(voice)}-[0-9a-f]{{10}}", old):
                    engine_json("DELETE", f"/v1/audio/voices/{old}")
    finally:
        sync_lock.release()


def check_voices() -> None:
    """The engine speaks an unknown voice name in its default voice without any error, so a deleted upload would
    silently change the voice. Drop missing ones (lines fall back to the clip) and upload them again."""
    have = uploaded_names()
    if have is None:
        return
    missing = [v for v, tag in list(engine_voice.items()) if tag not in have]
    stale = [v for v in voices() if v not in engine_voice or engine_voice[v] != voice_tag(v)]
    for v in missing:
        engine_voice.pop(v, None)
    if missing or stale:
        log(f"voice sync: {len(missing)} missing, {len(stale)} not uploaded; syncing")
        sync_voices()


def warm_up(gen: int = 0) -> None:
    """The first request after an engine start takes ~5 s (kernel warm-up, reference encoding); pay it here, once per
    voice, whenever the engine (re)appears, instead of on a caller's line. Uploads the voices first. With a warm-up
    generation `gen` (SGLang-Omni after a start), then sends the warm-up bursts and the staggered warm-up and only then
    lets /health say ready; a warm-up overtaken by a newer one (the engine dropped and came back meanwhile) leaves that
    to the newer one. Either step failing is logged by exception name and skipped (fail open)."""
    with warm_lock:
        try:
            sync_voices()
        except Exception as err:  # noqa: BLE001
            log(f"voice sync failed: {type(err).__name__}")
        for voice in voices():
            t0 = time.time()
            try:
                run_take("네, 알겠어요.", voice, 3.0)
                log(f"warm-up {voice}: {(time.time() - t0) * 1000:.0f} ms")
            except Exception as err:  # noqa: BLE001
                log(f"warm-up {voice} failed: {type(err).__name__}")
        if not gen:
            return
        state["warming"] = True
        t0 = time.time()
        try:
            # fail open: a cold first call beats a 503 until restart
            for step, what in ((warm_bursts, "warm-up bursts"), (warm_levels, "staggered warm-up")):
                if not state["ready"] or state["warm_gen"] != gen:
                    break
                try:
                    step()
                except Exception as err:  # noqa: BLE001
                    log(f"{what} failed: {type(err).__name__}; serving without them")
        finally:
            state["warming"] = False
        with lock:
            # else it went down again (it warms on its way back) or a newer warm-up is queued behind this one
            if state["ready"] and state["warm_gen"] == gen:
                state["warm"] = True
                log(f"ready: warm-up done in {(time.time() - t0) * 1000:.0f} ms")


def warm_bursts() -> None:
    """WARM_BURSTS lines at once each, straight to the engine (no adapter slot, so the engine sees the whole batch),
    all with the same voice and fixed text. Line failures are logged and counted, not fatal."""
    voice = "pickle" if "pickle" in voices() else next(iter(voices()), "none")
    t0 = time.time()
    for n in WARM_BURSTS:
        gate = threading.Barrier(n)

        def line(i: int) -> float:
            text = WARM_LINES[i % len(WARM_LINES)]
            t = Take(text, voice, stream_cap(text), use_slot=False)
            gate.wait(10)
            t1 = time.time()
            try:
                t.open()
                first = None
                for _ in t.pcm():
                    if first is None:
                        first = time.time() - t1
                return first if first is not None else float("nan")
            finally:
                t.close()

        t1 = time.time()
        with ThreadPoolExecutor(max_workers=n, thread_name_prefix="warm") as pool:
            futures = [pool.submit(line, i) for i in range(n)]
            done = [f.result() for f in futures if f.exception() is None]
            # exception names only (EngineDown carries its cause's name): the warm-up text is fixed, but keep logs bare
            errors = sorted({f"{type(e).__name__}:{e}" if isinstance(e, EngineDown) else type(e).__name__
                             for e in (f.exception() for f in futures) if e is not None})
        firsts = sorted(x for x in done if x == x)
        log(f"warm-up burst {n}: {(time.time() - t1) * 1000:.0f} ms, first audio max "
            f"{firsts[-1] * 1000 if firsts else float('nan'):.0f} ms, {n - len(done)} failed"
            f"{' (' + ', '.join(errors) + ')' if errors else ''}")
        if not engine_ready():
            log("warm-up bursts stopped: engine unreachable")
            return
    if WARM_BURSTS:
        log(f"warm-up bursts {','.join(map(str, WARM_BURSTS))}: {(time.time() - t0) * 1000:.0f} ms")


def pct(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else float("nan")


def warm_levels() -> None:
    """Staggered warm-up (SGLang-Omni): a call's line joins lines already decoding, one new prefill at a time, a shape
    the simultaneous bursts never make. At each level c of WARM_LEVELS, c workers send lines straight to the engine
    (no adapter slot) back to back for WARM_LEVEL_S, the first starts spread over one second, so arrivals interleave
    with running lines at every count from 1 to c. Logs first audio per level (p50, p95, max), numbers only.
    A worker stops after 3 failed lines; the warm-up stops when the engine goes away."""
    voice = "pickle" if "pickle" in voices() else next(iter(voices()), "none")
    t0 = time.time()
    for c in WARM_LEVELS:
        end = time.time() + WARM_LEVEL_S
        firsts: list[float] = []
        errors: list[str] = []
        rec = threading.Lock()

        def worker(i: int) -> None:
            time.sleep(i / c)
            k, failed = i, 0
            while time.time() < end and state["ready"] and failed < 3:
                text = WARM_LINES[k % len(WARM_LINES)]
                k += 1
                t = Take(text, voice, stream_cap(text), use_slot=False)
                t1 = time.time()
                try:
                    t.open()
                    first = None
                    for _ in t.pcm():
                        if first is None:
                            first = time.time() - t1
                    with rec:
                        firsts.append(first if first is not None else float("nan"))
                except Exception as err:  # noqa: BLE001 — counted; names only
                    failed += 1
                    with rec:
                        errors.append(f"{type(err).__name__}:{err}" if isinstance(err, EngineDown)
                                      else type(err).__name__)
                    time.sleep(0.2)
                finally:
                    t.close()

        t1 = time.time()
        with ThreadPoolExecutor(max_workers=c, thread_name_prefix="warm") as pool:
            list(pool.map(worker, range(c)))
        got = [x for x in firsts if x == x]
        log(f"warm-up level {c}: {len(firsts)} lines in {(time.time() - t1) * 1000:.0f} ms, first audio p50 "
            f"{pct(got, 0.5) * 1000:.0f} p95 {pct(got, 0.95) * 1000:.0f} max {pct(got, 1.0) * 1000:.0f} ms, "
            f"{len(errors)} failed{' (' + ', '.join(sorted(set(errors))) + ')' if errors else ''}")
        if not engine_ready():
            log("staggered warm-up stopped: engine unreachable")
            return
    if WARM_LEVELS:
        log(f"staggered warm-up {','.join(map(str, WARM_LEVELS))}: {(time.time() - t0) * 1000:.0f} ms")


class Take:
    """One engine line: one sentence, streamed back as raw PCM, holding one slot from open() to close().
    The silence guard runs while reading."""

    def __init__(self, text: str, voice: str, cap_s: float, use_slot: bool = True):
        self.text, self.voice = text, voice
        self.max_new_tokens = math.ceil(cap_s * FRAME_RATE) + 4
        self.conn: http.client.HTTPConnection | None = None
        self.resp: http.client.HTTPResponse | None = None
        self.use_slot = use_slot  # False only for the warm-up bursts, which must reach the engine all at once
        self.slot = False
        self.cut = ""

    def open(self, uploaded: bool = True) -> None:
        if self.use_slot and not self.slot:
            slots.acquire()
            self.slot = True
        body: dict = {"model": MODEL_ID, "input": self.text, "voice": "default", "response_format": "pcm",
                      "stream": True, "stream_format": "audio", "max_new_tokens": self.max_new_tokens}
        tag = engine_voice.get(self.voice) if uploaded else None
        if tag:
            body["voice"] = tag
        elif self.voice != "none" and ENGINE_KIND == "sglang":
            # the clip itself, from this Mac's voices/: no copy on the GPU box to drift. SGLang-Omni keys its encoded
            # reference by content, so only the first line with it pays the encode.
            body["references"] = [{"data": voice_clip_b64(self.voice), "media_type": "audio/wav",
                                   "text": voices()[self.voice]}]
        elif self.voice != "none":
            body["ref_audio"] = f"file://{ENGINE_VOICE_DIR}/{self.voice}.wav"
            body["ref_text"] = voices()[self.voice]
        try:
            self.conn = engine_conn(30)
            self.conn.request("POST", "/v1/audio/speech", json.dumps(body, ensure_ascii=False).encode(),
                              {"Content-Type": "application/json"})
            self.resp = self.conn.getresponse()
            status = self.resp.status
            if status != 200:
                self.resp.read(4096)
        except ENGINE_ERRORS as err:
            self.close()
            if isinstance(err, ConnectionError):  # refused, or the tunnel closed it unanswered: nothing is there
                engine_seen(False, hard=True, why=f"a line could not connect: {type(err).__name__}")
            else:  # a timeout is a slow engine, not a gone one: ask the watcher to look now
                probe_now.set()
            raise EngineDown(type(err).__name__) from err
        if status == 200:
            engine_seen(True)
        else:
            self.drop()
            if tag and status in (400, 404):  # the uploaded voice was refused: send the clip this once
                return self.open(uploaded=False)
            self.close()
            raise RuntimeError(f"engine status {status}")

    def pcm(self):
        """Yield s16le chunks (even length). Cuts a take that falls silent (babble guard)."""
        assert self.resp is not None
        win = 2048  # samples per silence window (46 ms)
        keep = int(KEEP_TAIL_S * SAMPLE_RATE / win)  # silent windows after speech passed on at once
        buf = b""
        held: list[bytes] = []  # silent windows past `keep`, not yet passed on (dropped if the take is cut)
        quiet = 0  # silent windows in a row
        spoke = False
        self.cut = ""
        while True:
            try:
                chunk = self.resp.read1(32768)
            except ENGINE_ERRORS as err:  # mid-line: proof of nothing on its own; the watcher looks now
                probe_now.set()
                raise EngineDown(type(err).__name__) from err
            if not chunk:
                break
            buf += chunk
            usable = len(buf) - len(buf) % (win * 2)
            if not usable:
                continue
            block, buf = buf[:usable], buf[usable:]
            out = []
            for i in range(0, usable, win * 2):
                w = block[i:i + win * 2]
                a = array("h")
                a.frombytes(w)
                if sys.byteorder == "big":
                    a.byteswap()
                if max(max(a), -min(a)) >= SILENT_PEAK:
                    spoke = True
                    out.extend(held)
                    held, quiet = [], 0
                    out.append(w)
                    continue
                quiet += 1
                if not spoke:  # before the first word: pass silence on at once (time to first byte), only count it
                    out.append(w)
                    if quiet * win / SAMPLE_RATE >= LEAD_CUT_S:
                        self.cut = "no-speech"
                elif quiet <= keep:
                    out.append(w)
                else:
                    held.append(w)
                    if quiet * win / SAMPLE_RATE >= SILENCE_CUT_S:
                        self.cut = "silence"
                if self.cut:
                    if out:
                        yield b"".join(out)
                    return
            if out:
                yield b"".join(out)
        # end of take: pass on what is left (a natural ending), dropping a half sample
        tail = b"".join(held) + buf
        tail = tail[: len(tail) - len(tail) % 2]
        if tail:
            yield tail

    def drop(self) -> None:
        # closing the socket makes the engine abort the request (both vLLM-Omni and SGLang-Omni watch for it)
        try:
            if self.conn is not None:
                self.conn.close()
        except OSError:
            pass
        self.conn = self.resp = None

    def close(self) -> None:
        self.drop()
        if self.slot:
            self.slot = False
            slots.release()


def run_take(text: str, voice: str, cap_s: float) -> tuple[bytes, str]:
    t = Take(text, voice, cap_s)
    try:
        t.open()
        return b"".join(t.pcm()), t.cut
    finally:
        t.close()


def synth_sentence(sentence: str, voice: str, cue: str) -> bytes:
    """/tts: one sentence with up to 3 takes, keeping the first inside bounds() (else the closest miss)."""
    low, high = bounds(sentence)
    best: tuple[bytes, float] | None = None
    for attempt in range(3):
        pcm, cut = run_take(cue + sentence, voice, high)
        dur = len(pcm) / 2 / SAMPLE_RATE
        if low <= dur < high - 0.05 and cut != "no-speech":
            return pcm
        if best is None or abs(dur - (low + high) / 2) < abs(best[1] - (low + high) / 2):
            best = (pcm, dur)
        log(f"retake {attempt + 1}: {dur:.2f}s outside [{low:.2f}, {high:.2f}){' (' + cut + ')' if cut else ''}")
    assert best is not None
    return best[0]


def synthesize(text: str, voice: str, direction: str | None) -> bytes:
    """/tts: sentences in parallel on the engine (it batches), at most 4 at once per line, joined with short pauses.
    The first failure ends the line: sentences not yet started are cancelled."""
    cue = f"[{direction.strip()}] " if direction and direction.strip() else ""
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="take")
    try:
        futures = [pool.submit(synth_sentence, s, voice, cue) for s in sentences(text)]
        parts = [f.result() for f in futures]
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    gap = bytes(int(GAP_S * SAMPLE_RATE) * 2)
    return gap.join(parts)


def wav_bytes(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def to_mp3(wav: bytes) -> bytes:
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "wav", "-i", "pipe:0", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
         "-ac", "1", "-ar", "24000", "-b:a", "64k", "-f", "mp3", "pipe:1"],
        input=wav, capture_output=True, check=True,
    )
    return proc.stdout


# ───────────────────────────── HTTP ─────────────────────────────


class Request:
    """Counts a request as in flight (/health inflight, busyMs)."""

    def __enter__(self):
        self.key = object()
        with lock:
            state["inflight"] += 1
            state["starts"][self.key] = time.time()
        return self

    def __exit__(self, *exc):
        with lock:
            state["inflight"] -= 1
            state["starts"].pop(self.key, None)
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "mosi-tts-remote/1"
    timeout = 60  # a client that stops reading (but keeps the socket) gives up its engine line after a minute

    def log_message(self, fmt: str, *args) -> None:
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

    def do_GET(self) -> None:
        if self.path != "/health":
            return self.json(404, {"error": "not_found"})
        ready = serving_ready()
        with lock:
            inflight = state["inflight"]
            oldest = min(state["starts"].values(), default=None)
        self.json(200, {"ok": True, "ready": ready, "model": MODEL_ID, "voices": sorted(voices()),
                        "sampleRate": SAMPLE_RATE, "queue": slots.queue(),
                        "busyMs": int((time.time() - oldest) * 1000) if oldest else 0,
                        "inflight": inflight, "slots": SLOTS, "backend": f"{ENGINE_LABEL} via {ENGINE}",
                        "warming": state["warming"]})

    def do_POST(self) -> None:
        if self.path not in ("/tts", "/tts/stream"):
            return self.json(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 64_000)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.json(400, {"error": "bad_json"})
        if not isinstance(body, dict):
            return self.json(400, {"error": "bad_json"})
        text = spoken(str(body.get("text") or ""))
        voice = str(body.get("voice") or "pickle")
        fmt = str(body.get("format") or "mp3")
        direction = body.get("direction") if isinstance(body.get("direction"), str) else None
        if not text or letters(text) == 0:
            return self.json(400, {"error": "empty_text"})
        if len(text) > MAX_CHARS:
            return self.json(413, {"error": "too_long", "max": MAX_CHARS})
        if voice != "none" and voice not in voices():
            return self.json(400, {"error": "unknown_voice"})
        if fmt not in ("mp3", "wav"):
            return self.json(400, {"error": "bad_format"})
        if not engine_ready():
            log(f"503 loading ({self.path}): engine not ready")
            return self.json(503, {"error": "loading"})
        if not state["warm"]:
            log(f"503 loading ({self.path}): warming up")
            return self.json(503, {"error": "loading"})
        if self.path == "/tts/stream":
            return self.stream(text, voice, direction)
        t0 = time.time()
        try:
            with Request():
                pcm = synthesize(text, voice, direction)
            wav = wav_bytes(pcm)
            audio = to_mp3(wav) if fmt == "mp3" else wav
        except EngineDown:
            log("503 loading (/tts): engine unreachable")
            return self.json(503, {"error": "loading"})
        except Exception as err:  # noqa: BLE001 — report, never crash the server
            log(f"synthesis failed: {type(err).__name__}")
            return self.json(500, {"error": "synthesis_failed"})
        dur = len(pcm) / 2 / SAMPLE_RATE
        ms = int((time.time() - t0) * 1000)
        log(f"{letters(text)} letters -> {dur:.1f}s audio in {ms} ms")
        self.reply(200, audio, "audio/mpeg" if fmt == "mp3" else "audio/wav",
                   {"X-Audio-Duration": f"{dur:.2f}", "X-Gen-Ms": str(ms), "Cache-Control": "no-store"})

    def stream(self, text: str, voice: str, direction: str | None) -> None:
        """Sentences one after another, each passed through as the engine decodes it. Our 200 goes out only with the
        first audio in hand, so an engine that fails before any sound is a clean 503/500, never an empty stream."""
        cue = f"[{direction.strip()}] " if direction and direction.strip() else ""
        parts = sentences(text)
        t0 = time.time()
        first = 0.0
        total = 0
        cuts = 0
        with Request():
            take = Take(cue + parts[0], voice, stream_cap(parts[0]))
            try:
                take.open()
                chunks = take.pcm()
                head = next(chunks, b"")
                if not head:
                    raise RuntimeError("no audio")
            except EngineDown:
                take.close()
                log("503 loading (/tts/stream): engine unreachable")
                return self.json(503, {"error": "loading"})
            except Exception as err:  # noqa: BLE001
                take.close()
                log(f"stream failed before audio: {type(err).__name__}")
                return self.json(500, {"error": "synthesis_failed"})
            first = time.time() - t0
            try:
                self.send_response(200)
                self.send_header("Content-Type", "audio/L16")
                self.send_header("X-Sample-Rate", str(SAMPLE_RATE))
                self.send_header("X-Channels", "1")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(head)
                self.wfile.flush()
                total += len(head)
                gap = bytes(int(GAP_S * SAMPLE_RATE) * 2)
                for i, sentence in enumerate(parts):
                    for attempt in range(2):
                        if i or attempt:
                            take = Take(cue + sentence, voice, stream_cap(sentence))
                            take.open()
                            chunks = take.pcm()
                            if i and not attempt:
                                self.wfile.write(gap)
                                total += len(gap)
                        try:
                            for pcm in chunks:
                                self.wfile.write(pcm)
                                self.wfile.flush()
                                total += len(pcm)
                            cuts += bool(take.cut)
                        finally:
                            take.close()
                        if take.cut != "no-speech":  # a take that said nothing (only silence went out): one more try
                            break
                log(f"stream: {letters(text)} letters, {len(parts)} sentences, first audio {first * 1000:.0f} ms, "
                    f"{total / 2 / SAMPLE_RATE:.1f}s audio in {(time.time() - t0) * 1000:.0f} ms"
                    f"{f', {cuts} cut by silence guard' if cuts else ''}")
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                log("stream: client went away")
            except Exception as err:  # noqa: BLE001
                log(f"stream failed: {type(err).__name__}")
            finally:
                take.close()


def main() -> None:
    if not voices():
        sys.exit(f"no voices in {VOICE_DIR} (need <name>.wav + <name>.txt)")
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer.request_queue_size = 128  # default 5 resets a burst of simultaneous connections
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"listening http://{HOST}:{PORT} -> {ENGINE_LABEL} {ENGINE} ({SLOTS} engine lines"
        f"{', warm-up bursts ' + ','.join(map(str, WARM_BURSTS)) if WARM_BURSTS else ''}"
        f"{f', staggered {WARM_LEVEL_S:g} s at ' + ','.join(map(str, WARM_LEVELS)) if WARM_LEVELS else ''}"
        f"; probe timeout {PROBE_TIMEOUT_S:g} s, unreachable after {PROBE_FAILS} failed); voices={sorted(voices())}")
    threading.Thread(target=watch_engine, daemon=True).start()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
