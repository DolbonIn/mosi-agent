"""Same-load benchmark for the Drama-3 engines (vLLM-Omni and SGLang-Omni), straight at the ENGINE port (stdlib only).

Both engines serve the same OpenAI-style API (POST /v1/audio/speech with stream=true, response_format=pcm, and
POST /v1/audio/voices), so one script drives either with identical requests. It never talks to the live adapter.

  # its own tunnel to the engine (started and stopped by the bench), GPU memory read with nvidia-smi over ssh:
  python3 -I engine_bench.py run --engine 127.0.0.1:18895 --tunnel gpu-host:8797 --gpu 6 --label sglang-gpu6 \
      --engine-name "sglang-omni 0.2.0" --out out/
  python3 -I engine_bench.py compare out/vllm-gpu6.json out/sglang-gpu6.json > out/compare.md
  # on the GPU box itself (engine-side TTFA, no network in it): no --tunnel, --ssh '' (nvidia-smi runs locally)
  python3 -I engine_bench.py run --engine 127.0.0.1:8797 --ssh '' --gpu 6 --voice-dir ~/mosi-tts/voices ...

What `run` does, in order:
  1. waits for /health 200, uploads the `pickle` voice (same name the adapter uses: mosi-pickle-<hash>) if missing,
     and sends a few warm-up lines;
  2. load: for each concurrency in --levels (default 1,2,4,8,12,16,24,32) keeps that many streams going until
     max(--requests, 3 x concurrency) lines are done. Lines are Korean call-reply sentences (fixtures below), the
     same sequence on every engine. Per level: TTFA p50/p95 (send -> first PCM byte), RTF p50/mean/p95 (line time /
     its audio), errors, lines with a >= 1.2 s silence after speech (Drama-3's babble), the GPU's peak memory and mean
     utilisation (--gpu, read-only nvidia-smi), and audio-seconds per wall-second two ways:
       audio_s_per_wall_s          sustained, with all N streams busy: N x sum(audio) / sum(line time) over the lines
                                   sent before the queue ran dry (the last N, which overlap the ramp-down, are left out)
       audio_s_per_wall_s_overall  all audio / the level's wall time, ramp-down tail included (lower);
  3. capacity under two rules, each the largest concurrency that passes with every smaller tested level passing too:
       max_streams_sla          TTFA p95 <= 300 ms, RTF mean <= 0.6, no errors (the lead's brief, RTF read as the mean)
       max_streams_sla_rtf_p95  the same with RTF p95 <= 0.6 (stricter: 95 % of lines, not the average line)
     --refine bisects between the last passing and the first failing level, for both rules;
  4. replies: three 3-sentence replies, each as ONE request vs one request per sentence played back to back with
     0.22 s gaps (what the adapter does today). TTFA and total time per run, and the wavs, to listen to.
Writes <out>/<label>.json (every line), <out>/<label>.jsonl (the raw rows) and <out>/<label>.md. Prints and stores numbers only; the text is fixtures.
The JSON's top level (engine, gpu, levels[] with concurrency / ttfa_p50_ms / ttfa_p95_ms / rtf_p50 / rtf_p95 /
audio_s_per_wall_s / n, max_streams_sla) is what the cost model's tts_cost.py reads. health_rtt_ms is the round trip of
a bare GET /health from where the bench runs (the tunnel's share of every TTFA when it runs on the Mac).
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import math
import os
import statistics
import subprocess
import sys
import threading
import time
import unicodedata
import wave
from array import array
from pathlib import Path

HERE = Path(__file__).resolve().parent
SAMPLE_RATE = 44100
FRAME_RATE = SAMPLE_RATE / 2048
MODEL_ID = "fishaudio/drama-3"
GAP_S = 0.22
SILENT_PEAK = 300  # same thresholds as the adapter's silence guard
SILENCE_RUN_S = 1.2
TTFA_P95_MAX_MS = 300.0
RTF_MEAN_MAX = 0.6
RTF_P95_MAX = 0.6

# Korean lines shaped like the agent's spoken call replies (fixtures; no user data). 11 to 38 characters, 27 on average:
# one sentence of a ~80-character, 3-sentence reply, which is how the adapter sends text today.
SENTENCES = [
    "네, 확인해 볼게요.",
    "지금 바로 일정 잡아 드릴까요?",
    "내일 오후 세 시에 회의가 하나 있어요.",
    "보내 주신 자료는 방금 다 읽어 봤어요.",
    "그 부분은 담당자한테 다시 물어보고 알려 드릴게요.",
    "오늘은 비 소식이 있으니까 우산 챙기시는 게 좋겠어요.",
    "주문하신 상품은 내일 오전 중에 도착할 예정이에요.",
    "잠깐만요, 메일함에서 그 내용 찾아볼게요.",
    "말씀하신 대로 금요일 저녁 일곱 시로 예약해 둘게요.",
    "혹시 다른 날짜도 괜찮으시면 후보를 몇 개 더 찾아볼까요?",
    "지난주 회의록을 보면 출시 일정은 다음 달 둘째 주로 정해져 있어요.",
    "네 좋아요, 그럼 그렇게 진행할게요.",
    "이번 달 카드 사용액은 지난달보다 조금 줄었어요.",
    "회의 시작 십 분 전에 한 번 더 알려 드릴게요.",
    "그 식당은 월요일이 휴무라서 화요일로 잡는 게 좋겠어요.",
    "통화 끝나면 정리한 내용을 메시지로 보내 드릴게요.",
    "아직 답장이 안 와서 오후에 한 번 더 확인해 볼게요.",
    "공항까지는 지금 출발하면 사십 분 정도 걸릴 것 같아요.",
    "알겠어요, 그 건은 다음 주 월요일까지 미뤄 둘게요.",
    "계약서 초안에서 바뀐 부분은 세 군데예요. 하나씩 읽어 드릴까요?",
    "오늘 저녁 약속은 일곱 시 반이고 장소는 강남역 근처예요.",
    "그건 제가 잘 모르겠어요. 확인되는 대로 바로 말씀드릴게요.",
    "네, 들려요. 말씀하세요.",
    "방금 보신 견적은 부가세 포함 금액이고 배송비는 따로예요.",
]

REPLIES = [
    ["네, 내일 일정 확인해 봤어요.", "오전 열 시에 팀 회의가 있고 오후 두 시에는 고객 미팅이 잡혀 있어요.",
     "미팅 자료는 오늘 저녁까지 정리해서 보내 드릴게요."],
    ["말씀하신 식당은 금요일 저녁에 자리가 있어요.", "일곱 시로 네 분 예약해 둘까요?",
     "주차는 건물 지하에 두 시간까지 무료래요."],
    ["방금 메일함을 확인해 봤는데 아직 답장은 안 왔어요.", "담당자가 오늘 휴가라서 내일 오전에 다시 확인해 볼게요.",
     "급하시면 다른 분께 먼저 연락해 드릴까요?"],
]


def letters(text: str) -> int:
    return sum(1 for ch in text if unicodedata.category(ch)[0] in "LN")


def stream_cap_frames(text: str) -> int:
    """The adapter's stream cap (1.0 s + 0.24 s per letter) in codec frames, as max_new_tokens."""
    return math.ceil((1.0 + 0.24 * letters(text)) * FRAME_RATE) + 4


def pct(values: list[float], q: float) -> float:
    """Nearest-rank percentile."""
    if not values:
        return float("nan")
    s = sorted(values)
    return s[max(0, min(len(s) - 1, math.ceil(q / 100 * len(s)) - 1))]


# ───────────────────────────── engine I/O ─────────────────────────────


class Engine:
    def __init__(self, hostport: str):
        host, _, port = hostport.rpartition(":")
        self.host, self.port = host or "127.0.0.1", int(port)

    def conn(self, timeout: float) -> http.client.HTTPConnection:
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    def json(self, method: str, path: str, body: bytes | None = None, ctype: str = "application/json") -> tuple[int, dict]:
        c = self.conn(60)
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

    def healthy(self) -> bool:
        try:
            c = self.conn(3)
            c.request("GET", "/health")
            r = c.getresponse()
            r.read()
            c.close()
            return r.status == 200
        except OSError:
            return False

    def health_rtt_ms(self, n: int = 10) -> dict:
        """Round trip of a bare GET /health (connect + request + answer), from where the bench runs."""
        times = []
        for _ in range(n):
            t0 = time.perf_counter()
            if self.healthy():
                times.append((time.perf_counter() - t0) * 1000)
        return {"p50": round(pct(times, 50), 1), "max": round(max(times), 1)} if times else {}

    def line(self, text: str, voice: str, max_new_tokens: int, keep: bool = False) -> dict:
        """One streamed line. Times are from just before the request is sent."""
        body = json.dumps({"model": MODEL_ID, "input": text, "voice": voice, "response_format": "pcm", "stream": True,
                           "stream_format": "audio", "max_new_tokens": max_new_tokens}, ensure_ascii=False).encode()
        out: dict = {"letters": letters(text), "status": 0, "error": ""}
        pcm = bytearray()
        t0 = time.perf_counter()
        first = None
        c = self.conn(120)
        try:
            c.request("POST", "/v1/audio/speech", body, {"Content-Type": "application/json"})
            r = c.getresponse()
            out["status"] = r.status
            if r.status != 200:
                out["error"] = f"status {r.status}"
                r.read(2048)
                return out
            rate = int(r.getheader("X-Sample-Rate") or SAMPLE_RATE)
            if rate != SAMPLE_RATE:
                out["error"] = f"sample rate {rate}"
                return out
            while True:
                chunk = r.read1(65536)
                if not chunk:
                    break
                if first is None:
                    first = time.perf_counter() - t0
                pcm += chunk
        except OSError as err:
            out["error"] = type(err).__name__
            return out
        finally:
            c.close()
        total = time.perf_counter() - t0
        if first is None or not pcm:
            out["error"] = "no audio"
            return out
        audio_s = len(pcm) / 2 / SAMPLE_RATE
        out.update(ttfa_ms=first * 1000, total_s=total, audio_s=audio_s, rtf=total / audio_s,
                   long_silence=long_silence(bytes(pcm)))
        if keep:
            out["pcm"] = bytes(pcm[: len(pcm) - len(pcm) % 2])
        return out


def long_silence(pcm: bytes) -> bool:
    """True when the line has a silent stretch of SILENCE_RUN_S or more after it started speaking (babble)."""
    win = 2048
    a = array("h")
    a.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        a.byteswap()
    spoke, quiet = False, 0
    for i in range(0, len(a) - win + 1, win):
        w = a[i:i + win]
        if max(max(w), -min(w)) >= SILENT_PEAK:
            spoke, quiet = True, 0
        elif spoke:
            quiet += 1
            if quiet * win / SAMPLE_RATE >= SILENCE_RUN_S:
                return True
    return False


def ensure_voice(engine: Engine, voice_dir: Path, voice: str) -> str:
    """Upload voices/<voice>.wav (+ .txt) under the adapter's name for it, unless the engine has it already."""
    wav = (voice_dir / f"{voice}.wav").read_bytes()
    transcript = (voice_dir / f"{voice}.txt").read_text(encoding="utf-8").strip()
    tag = f"mosi-{voice}-{hashlib.sha256(wav + transcript.encode()).hexdigest()[:10]}"
    status, listing = engine.json("GET", "/v1/audio/voices")
    if status != 200:
        raise SystemExit(f"voice list failed ({status})")
    if tag in {v.get("name") for v in listing.get("uploaded_voices", []) if isinstance(v, dict)}:
        return tag
    boundary = f"bench{time.time_ns()}"
    fields = [("name", tag), ("consent", "mosi-own-voice"), ("ref_text", transcript)]
    body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields)
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="audio_sample"; filename="{voice}.wav"\r\n'
             "Content-Type: audio/wav\r\n\r\n").encode() + wav + f"\r\n--{boundary}--\r\n".encode()
    status, _ = engine.json("POST", "/v1/audio/voices", body, f"multipart/form-data; boundary={boundary}")
    if status != 200:
        raise SystemExit(f"voice upload failed ({status})")
    return tag


# ───────────────────────────── GPU memory (read-only nvidia-smi over ssh) ─────────────────────────────


class GpuWatch:
    def __init__(self, ssh: str | None, gpu: int | None, every: float = 2.0):
        self.ssh, self.gpu, self.every = ssh, gpu, every
        self.samples: list[tuple[int, int]] = []
        self.stop_ev = threading.Event()
        self.thread: threading.Thread | None = None

    def read(self) -> tuple[int, int] | None:
        if self.gpu is None:
            return None
        cmd = ["nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits", "-i", str(self.gpu)]
        if self.ssh:
            cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", self.ssh, " ".join(cmd)]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()
            mem, util = (int(x.strip()) for x in out.split(","))
            return mem, util
        except (OSError, ValueError, subprocess.SubprocessError):
            return None

    def _loop(self) -> None:
        while not self.stop_ev.is_set():
            s = self.read()
            if s:
                self.samples.append(s)
            self.stop_ev.wait(self.every)

    def __enter__(self) -> "GpuWatch":
        self.samples = []
        if self.gpu is not None:
            self.stop_ev.clear()
            self.thread = threading.Thread(target=self._loop, daemon=True)
            self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        if self.thread:
            self.stop_ev.set()
            self.thread.join()

    def name(self) -> str | None:
        if self.gpu is None:
            return None
        cmd = ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader", "-i", str(self.gpu)]
        if self.ssh:
            cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", self.ssh, " ".join(cmd)]
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip() or None
        except (OSError, subprocess.SubprocessError):
            return None

    def summary(self) -> dict:
        if not self.samples:
            return {"gpu_mem_max_mib": None, "gpu_util_mean": None}
        return {"gpu_mem_max_mib": max(m for m, _ in self.samples),
                "gpu_util_mean": round(statistics.mean(u for _, u in self.samples), 1)}


# ───────────────────────────── load levels ─────────────────────────────


def run_level(engine: Engine, voice: str, n: int, total: int, gpu: GpuWatch) -> tuple[dict, list[dict]]:
    order = [SENTENCES[i % len(SENTENCES)] for i in range(total)]
    rows: list[dict] = []
    lock = threading.Lock()
    nxt = [0]

    def worker() -> None:
        while True:
            with lock:
                if nxt[0] >= total:
                    return
                i = nxt[0]
                nxt[0] += 1
            text = order[i]
            row = engine.line(text, voice, stream_cap_frames(text))
            row["i"] = i
            with lock:
                rows.append(row)

    with gpu:
        t0 = time.perf_counter()
        threads = [threading.Thread(target=worker) for _ in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        wall = time.perf_counter() - t0
    ok = [r for r in rows if not r["error"]]
    ttfa = [r["ttfa_ms"] for r in ok]
    rtf = [r["rtf"] for r in ok]
    # sustained throughput with all n streams busy (Little's law): leave out the last n lines sent, which overlap the
    # ramp-down when fewer than n streams are left; fall back to every line when that leaves too few
    steady = [r for r in ok if r["i"] < total - n] or ok
    busy_s = sum(r["total_s"] for r in steady)
    lvl = {"concurrency": n, "lines": len(rows), "n": len(ok), "errors": len(rows) - len(ok), "wall_s": round(wall, 2),
           "ttfa_p50_ms": round(pct(ttfa, 50), 1), "ttfa_p95_ms": round(pct(ttfa, 95), 1),
           "rtf_p50": round(pct(rtf, 50), 3), "rtf_mean": round(statistics.mean(rtf), 3) if rtf else None,
           "rtf_p95": round(pct(rtf, 95), 3),
           "audio_s_per_wall_s": round(n * sum(r["audio_s"] for r in steady) / busy_s, 2) if busy_s else None,
           "audio_s_per_wall_s_overall": round(sum(r["audio_s"] for r in ok) / wall, 2),
           "steady_lines": len(steady),
           "long_silence_lines": sum(1 for r in ok if r["long_silence"]), **gpu.summary()}
    base = bool(ok) and lvl["errors"] == 0 and lvl["ttfa_p95_ms"] <= TTFA_P95_MAX_MS
    lvl["pass"] = base and lvl["rtf_mean"] <= RTF_MEAN_MAX
    lvl["pass_rtf_p95"] = base and lvl["rtf_p95"] <= RTF_P95_MAX
    for r in rows:
        r["concurrency"] = n
    return lvl, rows


def print_level(lvl: dict) -> None:
    mem = f"{lvl['gpu_mem_max_mib']} MiB" if lvl["gpu_mem_max_mib"] is not None else "-"
    print(f"  c={lvl['concurrency']:>3}  lines {lvl['lines']:>3}  err {lvl['errors']}  TTFA p50 {lvl['ttfa_p50_ms']:>6.0f} "
          f"p95 {lvl['ttfa_p95_ms']:>6.0f} ms  RTF mean {lvl['rtf_mean']}  p95 {lvl['rtf_p95']}  "
          f"audio/wall {lvl['audio_s_per_wall_s']} (overall {lvl['audio_s_per_wall_s_overall']})  "
          f"babble {lvl['long_silence_lines']}  GPU {mem}  {'PASS' if lvl['pass'] else 'fail'}"
          f"{'' if lvl['pass_rtf_p95'] else ' (RTF p95 rule: fail)'}", flush=True)


# ───────────────────────────── replies: one request vs per sentence ─────────────────────────────


def write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)


def run_replies(engine: Engine, voice: str, runs: int, wav_dir: Path, label: str) -> list[dict]:
    wav_dir.mkdir(parents=True, exist_ok=True)
    gap = bytes(int(GAP_S * SAMPLE_RATE) * 2)
    out = []
    for ri, reply in enumerate(REPLIES, 1):
        whole = " ".join(reply)
        for k in range(1, runs + 1):
            one = engine.line(whole, voice, stream_cap_frames(whole), keep=True)
            t0 = time.perf_counter()
            parts, first_ms, err = [], None, ""
            for s in reply:  # sequential, like the adapter's /tts/stream
                r = engine.line(s, voice, stream_cap_frames(s), keep=True)
                if r["error"]:
                    err = r["error"]
                    break
                if first_ms is None:
                    first_ms = r["ttfa_ms"]
                parts.append(r["pcm"])
            split_total = time.perf_counter() - t0
            row = {"reply": ri, "run": k, "letters": letters(whole),
                   "one_ttfa_ms": round(one.get("ttfa_ms", float("nan")), 1), "one_total_s": round(one.get("total_s", float("nan")), 3),
                   "one_audio_s": round(one.get("audio_s", float("nan")), 2), "one_error": one["error"],
                   "split_ttfa_ms": round(first_ms, 1) if first_ms is not None else None, "split_total_s": round(split_total, 3),
                   "split_error": err}
            if not one["error"]:
                write_wav(wav_dir / f"{label}-reply{ri}-one-r{k}.wav", one["pcm"])
            if not err:
                pcm = gap.join(parts)
                row["split_audio_s"] = round(len(pcm) / 2 / SAMPLE_RATE, 2)
                write_wav(wav_dir / f"{label}-reply{ri}-split-r{k}.wav", pcm)
            out.append(row)
            print(f"  reply {ri} run {k}: one-request TTFA {row['one_ttfa_ms']:.0f} ms total {row['one_total_s']:.2f} s "
                  f"({row['one_audio_s']} s audio) | per-sentence TTFA {row['split_ttfa_ms'] or float('nan'):.0f} ms "
                  f"total {row['split_total_s']:.2f} s ({row.get('split_audio_s', '-')} s audio)", flush=True)
    return out


# ───────────────────────────── tunnel ─────────────────────────────


class Tunnel:
    """ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> <host>, started and stopped by the bench (by its own pid)."""

    def __init__(self, spec: str | None, local_port: int):
        self.proc: subprocess.Popen | None = None
        if spec:
            host, _, remote = spec.rpartition(":")
            self.cmd = ["ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15",
                        "-L", f"127.0.0.1:{local_port}:127.0.0.1:{int(remote)}", host]
        else:
            self.cmd = None

    def __enter__(self) -> "Tunnel":
        if self.cmd:
            self.proc = subprocess.Popen(self.cmd, stdin=subprocess.DEVNULL)
            time.sleep(2)
            if self.proc.poll() is not None:
                raise SystemExit(f"tunnel failed to start ({self.proc.returncode})")
        return self

    def __exit__(self, *exc) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(5)


# ───────────────────────────── commands ─────────────────────────────


def bisect_bounds(done: dict[int, dict], key: str) -> tuple[int, int | None]:
    """The last passing level of the passing run from the bottom, and the first failing level above it."""
    lo = 0
    for n in sorted(done):
        if not done[n][key]:
            return lo, n
        lo = n
    return lo, None


def capacity(levels: list[dict], key: str) -> int:
    """Largest concurrency that passes with every smaller tested level passing too."""
    cap = 0
    for lvl in levels:
        if not lvl[key]:
            break
        cap = lvl["concurrency"]
    return cap


def cmd_run(args: argparse.Namespace) -> None:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    engine = Engine(args.engine)
    gpu = GpuWatch(args.ssh, args.gpu)
    levels = [int(x) for x in args.levels.split(",") if x.strip()]
    with Tunnel(args.tunnel, engine.port):
        deadline = time.time() + args.wait
        while not engine.healthy():
            if time.time() > deadline:
                raise SystemExit("engine not healthy")
            time.sleep(2)
        voice = ensure_voice(engine, Path(args.voice_dir), args.voice)
        for text in SENTENCES[:3]:  # warm-up: first lines after a start or an upload pay one-off costs
            engine.line(text, voice, stream_cap_frames(text))
        gpu_name = gpu.name()
        result: dict = {"label": args.label, "engine": args.engine_name or args.label, "engine_addr": args.engine,
                        "tunnel": args.tunnel, "measured_at": f"Mac via ssh tunnel {args.tunnel}" if args.tunnel else
                        f"{args.engine} directly (no tunnel)", "health_rtt_ms": engine.health_rtt_ms(),
                        "gpu": f"{gpu_name or 'GPU'} (index {args.gpu})" if args.gpu is not None else None,
                        "gpu_index": args.gpu, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "voice": args.voice,
                        "rule": f"TTFA p95 <= {TTFA_P95_MAX_MS:.0f} ms, RTF mean <= {RTF_MEAN_MAX}, no errors",
                        "rule_rtf_p95": f"TTFA p95 <= {TTFA_P95_MAX_MS:.0f} ms, RTF p95 <= {RTF_P95_MAX}, no errors",
                        "gpu_idle": None, "levels": [], "replies": [], "lines": []}
        idle = gpu.read()
        result["gpu_idle"] = {"mem_mib": idle[0], "util": idle[1]} if idle else None
        if not args.skip_load:
            print(f"[{args.label}] load (lines per level = max({args.requests}, 3 x concurrency))", flush=True)
            done: dict[int, dict] = {}
            for n in levels:
                lvl, rows = run_level(engine, voice, n, max(args.requests, 3 * n), gpu)
                done[n] = lvl
                result["lines"] += rows
                print_level(lvl)
            if args.refine:
                for key in ("pass", "pass_rtf_p95"):
                    lo, hi = bisect_bounds(done, key)
                    while hi is not None and hi - lo > 1:
                        mid = (lo + hi) // 2
                        if mid not in done:
                            lvl, rows = run_level(engine, voice, mid, max(args.requests, 3 * mid), gpu)
                            done[mid] = lvl
                            result["lines"] += rows
                            print_level(lvl)
                        lo, hi = (mid, hi) if done[mid][key] else (lo, mid)
            result["levels"] = [done[n] for n in sorted(done)]
            result["max_streams_sla"] = capacity(result["levels"], "pass")
            result["max_streams_sla_rtf_p95"] = capacity(result["levels"], "pass_rtf_p95")
            result["capacity_streams"] = result["max_streams_sla"]
            print(f"[{args.label}] capacity: {result['max_streams_sla']} concurrent streams ({result['rule']}); "
                  f"{result['max_streams_sla_rtf_p95']} with RTF p95", flush=True)
        if not args.skip_replies:
            print(f"[{args.label}] replies: one request vs per sentence (+{GAP_S} s gaps)", flush=True)
            result["replies"] = run_replies(engine, voice, args.reply_runs, out_dir / "wav", args.label)
    for row in result["lines"]:
        row.pop("pcm", None)
    (out_dir / f"{args.label}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1))
    with (out_dir / f"{args.label}.jsonl").open("w") as f:  # raw rows, one per request (load) or reply run; numbers only
        for row in result["lines"]:
            f.write(json.dumps({"kind": "load", "label": args.label, **row}) + "\n")
        for row in result["replies"]:
            f.write(json.dumps({"kind": "reply", "label": args.label, **row}) + "\n")
    (out_dir / f"{args.label}.md").write_text(markdown([result]))
    print(f"[{args.label}] wrote {out_dir / (args.label + '.json')}, .jsonl and .md", flush=True)


def markdown(results: list[dict]) -> str:
    lines = []
    head = ("| engine | c | lines | err | TTFA p50 | TTFA p95 | RTF mean | RTF p95 | audio s / wall s (sustained, overall) "
            "| babble | GPU mem max | pass (RTF mean, RTF p95) |")
    lines += [head, "|" + "---|" * 12]
    for res in results:
        for l in res["levels"]:
            mem = f"{l['gpu_mem_max_mib']} MiB" if l.get("gpu_mem_max_mib") is not None else "-"
            lines.append(f"| {res['label']} | {l['concurrency']} | {l['lines']} | {l['errors']} | {l['ttfa_p50_ms']:.0f} ms | "
                         f"{l['ttfa_p95_ms']:.0f} ms | {l['rtf_mean']} | {l['rtf_p95']} | "
                         f"{l['audio_s_per_wall_s']}, {l.get('audio_s_per_wall_s_overall', '-')} | "
                         f"{l['long_silence_lines']} | {mem} | {'yes' if l['pass'] else 'no'}, "
                         f"{'yes' if l.get('pass_rtf_p95') else 'no'} |")
    lines.append("")
    for res in results:
        if "max_streams_sla" in res:
            rtt = res.get("health_rtt_ms", {}).get("p50")
            lines.append(f"- {res['label']} ({res['engine']}, {res.get('gpu') or 'GPU ?'}, {res.get('measured_at')}, "
                         f"/health round trip {rtt} ms): **{res['max_streams_sla']}** concurrent streams within "
                         f"{res['rule']}; **{res['max_streams_sla_rtf_p95']}** within {res['rule_rtf_p95']}")
    rep = [(res["label"], res["replies"]) for res in results if res.get("replies")]
    if rep:
        lines += ["", "| engine | reply | one-request TTFA | one-request total | per-sentence TTFA | per-sentence total |",
                  "|---|---|---|---|---|---|"]
        for label, rows in rep:
            for ri in sorted({r["reply"] for r in rows}):
                rs = [r for r in rows if r["reply"] == ri and not r["one_error"] and not r["split_error"]]
                if not rs:
                    continue
                med = lambda k: statistics.median(r[k] for r in rs)  # noqa: E731
                lines.append(f"| {label} | {ri} ({rs[0]['letters']} letters) | {med('one_ttfa_ms'):.0f} ms | "
                             f"{med('one_total_s'):.2f} s | {med('split_ttfa_ms'):.0f} ms | {med('split_total_s'):.2f} s |")
    return "\n".join(lines) + "\n"


def cmd_compare(args: argparse.Namespace) -> None:
    sys.stdout.write(markdown([json.loads(Path(p).read_text()) for p in args.results]))


def main() -> None:
    ap = argparse.ArgumentParser(description="Drama-3 engine benchmark (vLLM-Omni / SGLang-Omni), same load for both")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="benchmark one engine")
    r.add_argument("--engine", required=True, help="host:port of the engine (the tunnel's local end)")
    r.add_argument("--label", required=True, help="name for the results, e.g. sglang-gpu6")
    r.add_argument("--engine-name", help='what is being measured, e.g. "sglang-omni 0.2.0" (default: the label)')
    r.add_argument("--out", default="bench-out")
    r.add_argument("--tunnel", help="HOST:REMOTE_PORT; the bench runs ssh -L <engine port>:127.0.0.1:REMOTE_PORT HOST itself")
    r.add_argument("--ssh", default="gpu-host", help="host for nvidia-smi (empty: run it locally)")
    r.add_argument("--gpu", type=int, help="GPU index to watch (read-only nvidia-smi); omit to skip")
    r.add_argument("--levels", default="1,2,4,8,12,16,24,32")
    r.add_argument("--requests", type=int, default=24, help="minimum lines per level (3 x concurrency if larger)")
    r.add_argument("--refine", action="store_true", help="bisect between the last passing and first failing level")
    r.add_argument("--reply-runs", type=int, default=3)
    r.add_argument("--skip-load", action="store_true")
    r.add_argument("--skip-replies", action="store_true")
    r.add_argument("--voice", default="pickle")
    r.add_argument("--voice-dir", default=str(HERE.parent.parent / "tts" / "voices"))
    r.add_argument("--wait", type=float, default=30.0, help="seconds to wait for /health 200")
    r.set_defaults(func=cmd_run)
    c = sub.add_parser("compare", help="one markdown table from several result JSONs")
    c.add_argument("results", nargs="+")
    c.set_defaults(func=cmd_compare)
    args = ap.parse_args()
    if getattr(args, "ssh", None) == "":
        args.ssh = None
    args.func(args)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    main()
