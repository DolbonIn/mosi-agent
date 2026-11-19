"""A stand-in for the GPU engine, for testing server.py and engine_bench.py without a GPU (stdlib only).

    python3 -I fake_engine.py --port 18895 --kind sglang     # or --kind vllm

It speaks the part of the engine API the adapter and the bench use, with the request checks of the real servers:
  GET /health                     200 once "started" (--start-delay s of 503 first, like a loading engine)
  GET/POST/DELETE /v1/audio/voices  list / multipart upload (audio_sample, consent, name, ref_text) / delete
  POST /v1/audio/speech           stream=true + response_format=pcm -> chunked s16le mono 44.1 kHz (audio/pcm)

--kind sglang copies SGLang-Omni 0.2.0's Drama-3 rules: only its supported speech fields are accepted (anything else
is a 400), references[] items need data (base64 WAV) or audio_path or vq_codes, file:// is refused unless
--allowed-local-media-path covers it, voice names are case-folded and limited to letters, digits, '.', '_' and '-'.
--kind vllm accepts what vLLM-Omni's Drama-3 path takes (ref_audio + ref_text, no sampling overrides).

The "audio" is a tone whose length follows the text (about 0.13 s per letter, capped by max_new_tokens frames),
sent at --rtf of real time after a first chunk at --ttfa-ms; --max-running requests run at once and the rest queue,
so concurrency raises TTFA the way a busy engine does. --cold-ms adds that much to the first audio of a line that
starts with a number of lines running that the engine has not run before (SGLang-Omni compiles kernels per new batch
size; 2026-11-14 that cost 1.1-1.6 s). With --cold-key mix the shape is instead (lines already running when a prefill
group began, place in that group), a group being the lines that arrive within --prefill-window-ms of its first: real
calls join running lines one at a time, (d, 1), which simultaneous bursts, (0, 1..n), never make. GET /_stats also gives
max_running_seen, running_at_start (lines running when each line started, by count) and cold_lines.
--slow-health MIN-MAX makes /health take MIN to MAX ms while at least --slow-health-running lines run (SGLang-Omni's
/health under load on 2026-11-15). Logs request counts and timings only, never text.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import random
import re
import struct
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SAMPLE_RATE = 44100
FRAME = 2048  # samples per codec frame (21.5 frames/s)
# SGLang-Omni 0.2.0 Drama3PipelineConfig.supported_speech_fields
SGLANG_FIELDS = {"model", "input", "voice", "response_format", "speed", "stream", "stream_format", "references",
                 "ref_audio", "ref_text", "task_type", "max_new_tokens", "temperature", "top_p", "top_k",
                 "repetition_penalty", "stream_audio", "split_granularity"}
VLLM_FIELDS = {"model", "input", "voice", "response_format", "speed", "stream", "stream_format", "ref_audio", "ref_text",
               "task_type", "max_new_tokens", "language", "instructions"}
VOICE_NAME = re.compile(r"[A-Za-z0-9._-]+")


def letters(text: str) -> int:
    return sum(1 for ch in text if unicodedata.category(ch)[0] in "LN")


class Engine:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.t0 = time.time()
        self.voices: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.slots = threading.Semaphore(args.max_running)
        self.stats = {"speech": 0, "rejected": 0, "aborted": 0, "uploads": 0, "deletes": 0, "uploaded_voice_lines": 0,
                      "inline_reference_lines": 0, "default_voice_lines": 0, "cold_lines": 0, "max_running_seen": 0}
        self.running = 0
        self.seen_sizes: set = set()
        self.running_at_start: dict[int, int] = {}
        self.group_t, self.group_base, self.group_n = 0.0, 0, 0  # the current prefill group (--cold-key mix)

    def started(self) -> bool:
        return time.time() - self.t0 >= self.args.start_delay

    def count(self, key: str) -> None:
        with self.lock:
            self.stats[key] += 1


def wav_ok(raw: bytes) -> bool:
    return len(raw) > 44 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"


# one second of a 220 Hz tone at about -12 dBFS: a whole number of periods, so it loops without a click
TONE = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 220 * i / SAMPLE_RATE))) for i in range(SAMPLE_RATE))


def tone(n: int, start: int) -> bytes:
    """n samples of the tone, continuing from sample `start`."""
    out, pos = b"", start % SAMPLE_RATE
    while len(out) < n * 2:
        take = min(n - len(out) // 2, SAMPLE_RATE - pos)
        out += TONE[pos * 2:(pos + take) * 2]
        pos = 0
    return out


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128  # listen() backlog; must be set before the socket listens (the default 5 resets bursts)


def make_handler(engine: Engine):
    kind = engine.args.kind

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args) -> None:
            return

        def send_json(self, code: int, obj: dict) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def bad(self, msg: str) -> None:
            engine.count("rejected")
            self.send_json(400, {"error": {"message": msg, "type": "invalid_request_error", "code": 400}})

        def body(self) -> bytes:
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def do_GET(self) -> None:
            if self.path == "/health":
                slow = engine.args.slow_health
                if slow and engine.running >= engine.args.slow_health_running:
                    lo, _, hi = slow.partition("-")
                    time.sleep(random.uniform(float(lo), float(hi or lo)) / 1000)
                if engine.started():
                    return self.send_json(200, {"status": "healthy", "running": True})
                return self.send_json(503, {"status": "starting"})
            if self.path.startswith("/v1/audio/voices"):
                with engine.lock:
                    up = [dict(v) for v in engine.voices.values()]
                return self.send_json(200, {"voices": sorted(["default"] + [v["name"] for v in up]),
                                            "uploaded_voices": up, "cache_stats": {}})
            if self.path == "/_stats":
                with engine.lock:
                    return self.send_json(200, {**engine.stats, "running_at_start": dict(sorted(
                        engine.running_at_start.items()))})
            self.send_json(404, {"error": "not found"})

        def do_DELETE(self) -> None:
            m = re.fullmatch(r"/v1/audio/voices/([^/]+)", self.path)
            if not m:
                return self.send_json(404, {"error": "not found"})
            name = m.group(1).lower() if kind == "sglang" else m.group(1)
            with engine.lock:
                found = engine.voices.pop(name, None)
                engine.stats["deletes"] += 1
            if not found:
                return self.send_json(404, {"success": False, "error": f"Voice '{name}' not found"})
            self.send_json(200, {"success": True})

        def do_POST(self) -> None:
            if not engine.started():
                self.body()
                return self.send_json(503, {"status": "starting"})
            if self.path == "/v1/audio/voices":
                return self.upload()
            if self.path == "/v1/audio/speech":
                return self.speech()
            self.body()
            self.send_json(404, {"error": "not found"})

        def upload(self) -> None:
            ctype = self.headers.get("Content-Type", "")
            m = re.search(r"boundary=(\S+)", ctype)
            raw = self.body()
            if engine.args.refuse_uploads:  # to exercise a client's no-upload path
                return self.bad("uploads refused (--refuse-uploads)")
            if not m:
                return self.bad("multipart body required")
            fields: dict[str, bytes] = {}
            for part in raw.split(b"--" + m.group(1).encode()):
                head, _, value = part.partition(b"\r\n\r\n")
                nm = re.search(rb'name="([^"]+)"', head)
                if nm:
                    fields[nm.group(1).decode()] = value[:-2] if value.endswith(b"\r\n") else value
            for need in ("audio_sample", "consent", "name"):
                if need not in fields:
                    return self.bad(f"{need} is required")
            name = fields["name"].decode().strip()
            if kind == "sglang":
                if not VOICE_NAME.fullmatch(name):
                    return self.bad("name must contain only letters, numbers, '.', '_', and '-'")
                name = name.lower()
            if not wav_ok(fields["audio_sample"]):
                return self.bad("audio_sample is not a WAV file")
            with engine.lock:
                engine.voices[name] = {"name": name, "consent": fields["consent"].decode(),
                                       "created_at": int(time.time()), "file_size": len(fields["audio_sample"]),
                                       "mime_type": "audio/wav", "ref_text": fields.get("ref_text", b"").decode()}
                engine.stats["uploads"] += 1
            self.send_json(200, {"success": True, "voice": {"name": name}})

        def speech(self) -> None:
            try:
                req = json.loads(self.body() or b"{}")
            except json.JSONDecodeError:
                return self.bad("speech request body must be valid JSON")
            if not isinstance(req, dict):
                return self.bad("speech request body must be an object")
            allowed = SGLANG_FIELDS if kind == "sglang" else VLLM_FIELDS
            extra = sorted(set(req) - allowed)
            if extra:
                return self.bad(f"unsupported speech fields for Drama 3: {', '.join(extra)}")
            text = req.get("input")
            if not isinstance(text, str) or not text.strip():
                return self.bad("input must be a non-empty string")
            if not req.get("stream") or req.get("response_format") != "pcm":
                return self.bad("this fake serves stream=true, response_format=pcm only")
            how = self.voice_source(req)
            if how is None:
                return
            engine.count(how)
            frames_cap = int(req.get("max_new_tokens") or 2048)
            want = max(0.4, 0.13 * letters(text))
            samples = min(int(want * SAMPLE_RATE), frames_cap * FRAME)
            self.stream(samples)

        def voice_source(self, req: dict) -> str | None:
            refs = req.get("references")
            if refs is not None:
                if kind != "sglang":
                    self.bad("references is not supported")
                    return None
                if not isinstance(refs, list) or not refs:
                    self.bad("references must be a non-empty list")
                    return None
                for i, r in enumerate(refs):
                    if not isinstance(r, dict):
                        self.bad(f"references.{i} must be an object")
                        return None
                    if r.get("data") is not None:
                        try:
                            ok = wav_ok(base64.b64decode(r["data"], validate=True))
                        except ValueError:
                            ok = False
                        if not ok:
                            self.bad(f"references.{i}.data is not base64 WAV")
                            return None
                    elif r.get("audio_path") is None and r.get("vq_codes") is None:
                        self.bad(f"Drama 3 request: references.{i} needs audio or vq_codes")
                        return None
                return "inline_reference_lines"
            ref = req.get("ref_audio")
            if ref is not None:
                if isinstance(ref, str) and ref.startswith("file://"):
                    root = engine.args.allowed_local_media_path
                    if not root or not ref[len("file://"):].startswith(root.rstrip("/") + "/"):
                        self.bad("file:// references are disabled")
                        return None
                if not req.get("ref_text"):
                    self.bad("ref_text is required with ref_audio")
                    return None
                return "inline_reference_lines"
            voice = req.get("voice") or "default"
            key = voice.lower() if kind == "sglang" else voice
            with engine.lock:
                known = key in engine.voices
            # both real engines speak an unknown voice name in the default voice, with no error
            return "uploaded_voice_lines" if known else "default_voice_lines"

        def stream(self, samples: int) -> None:
            a = engine.args
            engine.slots.acquire()  # a busy engine: the line waits here, which shows up as a later first byte
            with engine.lock:
                before = engine.running
                engine.running += 1
                size = engine.running
                key: object = size
                if a.cold_key == "mix":
                    now = time.time()
                    if now - engine.group_t > a.prefill_window_ms / 1000:
                        engine.group_t, engine.group_base, engine.group_n = now, before, 0
                    engine.group_n += 1
                    key = (engine.group_base, engine.group_n)
                cold = key not in engine.seen_sizes and a.cold_ms > 0
                engine.seen_sizes.add(key)
                engine.running_at_start[size] = engine.running_at_start.get(size, 0) + 1
                engine.stats["max_running_seen"] = max(engine.stats["max_running_seen"], size)
                engine.stats["cold_lines"] += cold
            try:
                engine.count("speech")
                time.sleep((a.ttfa_ms + (a.cold_ms if cold else 0)) / 1000)  # headers go out with the first audio
                self.send_response(200)
                self.send_header("Content-Type", "audio/pcm")
                self.send_header("X-Sample-Rate", str(SAMPLE_RATE))
                self.send_header("X-Channels", "1")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                sent, first = 0, True
                while sent < samples:
                    n = min(samples - sent, 4 * FRAME if first else 16 * FRAME)
                    chunk = tone(n, sent)
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.flush()
                    sent += n
                    first = False
                    time.sleep(n / SAMPLE_RATE * a.rtf)
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except OSError:
                engine.count("aborted")
            finally:
                with engine.lock:
                    engine.running -= 1
                engine.slots.release()

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=18895)
    ap.add_argument("--kind", choices=("sglang", "vllm"), default="sglang")
    ap.add_argument("--ttfa-ms", type=float, default=60.0)
    ap.add_argument("--rtf", type=float, default=0.2)
    ap.add_argument("--max-running", type=int, default=16)
    ap.add_argument("--start-delay", type=float, default=0.0)
    ap.add_argument("--allowed-local-media-path", default="/voices")
    ap.add_argument("--refuse-uploads", action="store_true", help="answer every voice upload with 400")
    ap.add_argument("--cold-ms", type=float, default=0.0, help="extra first-audio delay at a not-yet-seen batch size")
    ap.add_argument("--cold-key", choices=("size", "mix"), default="size",
                    help="what counts as a new shape: lines running (size) or (running before, place in prefill group)")
    ap.add_argument("--prefill-window-ms", type=float, default=20.0, help="--cold-key mix: arrivals this close group")
    ap.add_argument("--slow-health", default="", help="MIN-MAX ms that /health takes while lines run (e.g. 2000-4000)")
    ap.add_argument("--slow-health-running", type=int, default=1, help="lines running for --slow-health to apply")
    args = ap.parse_args()
    server = Server(("127.0.0.1", args.port), make_handler(Engine(args)))
    print(f"[fake-engine] {args.kind} on 127.0.0.1:{args.port} (ttfa {args.ttfa_ms:.0f} ms, rtf {args.rtf}, "
          f"{args.max_running} at once)", file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
