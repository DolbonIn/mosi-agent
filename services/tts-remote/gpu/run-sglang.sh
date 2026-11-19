#!/bin/sh
# Start one 모시 Drama-3 engine on SGLang-Omni 0.2.0 as a docker container (default name `mosi-sgl`, port 8797).
# Run it ON the GPU box from ~/mosi-tts after install-sglang.sh. See ../README.md ("SGLang-Omni 엔진").
#
#   MOSI_SGL_GPU=6 ./run-sglang.sh                                   # mosi-sgl on GPU 6, 127.0.0.1:8797
#   MOSI_SGL_GPU=7 MOSI_SGL_NAME=mosi-sgl-b MOSI_SGL_PORT=8798 ./run-sglang.sh   # a second one (blue/green)
#
# MOSI_SGL_GPU has no default on purpose: name the GPU you were given. The guards are run-engine.sh's: GPUs 0-3 are
# refused (other people's jobs), so is a GPU with any process or more than 2 GB in use, and a running container of
# this name is never replaced (MOSI_SGL_REPLACE=1 only if nothing uses it). The engine listens on 127.0.0.1 only.
#
# Image: the vllm/vllm-openai:v0.32.0 already on the box (CUDA 13.0, gcc for Triton, libavcodec), nothing pulled.
# The Python environment is the NFS venv from install-sglang.sh, mounted read-only at the same path.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
GPU="${MOSI_SGL_GPU:-}"
PORT="${MOSI_SGL_PORT:-8797}"
NAME="${MOSI_SGL_NAME:-mosi-sgl}"
IMAGE="${MOSI_SGL_IMAGE:-vllm/vllm-openai:v0.32.0}"
ROOT="${MOSI_SGL_ROOT:-/mnt/shared/mosi-tts/sgl}"
VENV="$ROOT/venv-0.2.0"
DATA="${MOSI_TTS_DATA:-/mnt/shared/mosi-tts}"   # HF cache with fishaudio/drama-3 (NFS)
# The drama-3 revision on NFS. Its codec.pth is byte-identical (sha256 74fc41c5...) to the one SGLang-Omni would
# download from fishaudio/s2-pro@1de9996, so the vocoder reads it from here and the engine runs fully offline.
REVISION="${MOSI_SGL_REVISION:-78e5ab79e49aa9a25abe8799eff2c4d73a1c3216}"
MAX_RUNNING="${MOSI_SGL_MAX_RUNNING:-32}"     # engine requests at once (SGLang-Omni default 16; the bench goes to 32)
STRIDE="${MOSI_SGL_STREAM_STRIDE:-4}"         # first streamed window in frames: 0.2.0 says 10, main (f461b8e) says 4
EXTRA="${MOSI_SGL_EXTRA_ARGS:-}"              # e.g. "--mps on"

case "$GPU" in
  "") echo "set MOSI_SGL_GPU to the GPU you were given (4-7)" >&2; exit 1 ;;
  0|1|2|3) echo "refusing GPU $GPU: GPUs 0-3 belong to other people's jobs" >&2; exit 1 ;;
  4|5|6|7) ;;
  *) echo "MOSI_SGL_GPU must be one GPU index 4-7, got '$GPU'" >&2; exit 1 ;;
esac
[ -x "$VENV/bin/sgl-omni" ] || { echo "no $VENV/bin/sgl-omni: run install-sglang.sh first" >&2; exit 1; }
CODEC_DIR="$DATA/hf/hub/models--fishaudio--drama-3/snapshots/$REVISION"
[ -f "$CODEC_DIR/codec.pth" ] || { echo "no codec.pth in $CODEC_DIR" >&2; exit 1; }

if docker ps -q --filter "name=^/$NAME\$" | grep -q . && [ "${MOSI_SGL_REPLACE:-0}" != 1 ]; then
  echo "$NAME is running; replacing it silences its port for minutes. Start a second engine under another" >&2
  echo "MOSI_SGL_NAME/GPU/PORT instead, or set MOSI_SGL_REPLACE=1 if nothing uses this one." >&2
  exit 1
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
sleep 2
used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i "$GPU" | tr -d ' ')
procs=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader -i "$GPU" | grep -c . || true)
if [ "$procs" -gt 0 ] || [ "$used" -gt 2048 ]; then
  echo "GPU $GPU is busy ($procs processes, ${used} MiB used); not starting" >&2
  exit 1
fi
mkdir -p "$ROOT/cache/speakers"

# Memory on one 96 GB card (94.97 GiB): SGLang-Omni's defaults, engine 0.70 + vocoder 0.10 of the card plus the
# preprocessing stage's 6 GiB reserve = 82.0 GiB, which passes its startup check (declared budgets <= VRAM) and leaves
# ~13 GiB for the three processes' CUDA contexts. The cookbook's 0.85 engine share risks OOM with the vocoder on the
# same card, so it stays at 0.70; the KV cache for 32 requests fits inside it.
# LD_LIBRARY_PATH drops the image's CUDA 13.0 toolkit dirs so they cannot shadow the venv's pip CUDA 13.x libraries.
# shellcheck disable=SC2086
docker run -d --name "$NAME" --restart unless-stopped \
  --gpus "\"device=$GPU\"" --shm-size 16g \
  --user "$(id -u):$(id -g)" -e HOME=/cache \
  -p "127.0.0.1:$PORT:8000" \
  -e LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/nvidia/lib \
  -e PATH="$VENV/bin:/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -e HF_HOME=/hf -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e DO_NOT_TRACK=1 \
  -e SPEAKER_SAMPLES_DIR=/cache/speakers -e TRITON_CACHE_DIR=/cache/triton \
  -e TORCHINDUCTOR_CACHE_DIR=/cache/inductor -e XDG_CACHE_HOME=/cache/.cache \
  -v "$ROOT:$ROOT:ro" -v "$ROOT/cache:/cache" -v "$DATA/hf:/hf:ro" -v "$HERE/voices:/voices:ro" \
  --log-opt max-size=50m --log-opt max-file=3 \
  --entrypoint "$VENV/bin/sgl-omni" \
  "$IMAGE" serve \
  --model-path fishaudio/drama-3 --model-name fishaudio/drama-3 --host 0.0.0.0 --port 8000 \
  --allowed-local-media-path /voices \
  --vocoder.factory.codec_path "/hf/hub/models--fishaudio--drama-3/snapshots/$REVISION" \
  --vocoder.factory.stream_stride "$STRIDE" \
  --tts_engine.factory.max_running_requests "$MAX_RUNNING" \
  $EXTRA
echo "started $NAME on GPU $GPU, http://127.0.0.1:$PORT (docker logs -f $NAME; ready when /health is 200)"
